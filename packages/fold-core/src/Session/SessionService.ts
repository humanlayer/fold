/**
 * This file defines the Session service contract - the public SDK facade over one fold session. A caller
 * starts a session (which mints the session and root-agent ids and appends the first durable rows), sends
 * user turns to the root agent, and subscribes to a merged stream of durable log rows and ephemeral
 * deltas. One provided Session instance represents exactly one session, mirroring EventLog.
 *
 * The live service is the facade over AgentRuntime, EventLog, Ids, and AgentEvents. It owns the single session/root-agent identity in a Ref, appends `session_started` as the
 * first durable row, starts the root agent, and exposes `events` as the merge of durable EventLog replay
 * (mapped to `kind: 'log'`) with the ephemeral AgentEvents delta stream.
 */
import { Context, Effect, type Schema, Stream, Layer, Ref } from 'effect'

import { type FoldEvent, AgentEvents } from '../AgentEvents/AgentEventsService'
import { AgentRuntime } from '../AgentRuntime/AgentRuntimeService'
import { openSession, type OpenSessionOptions } from '../Api/OpenSession'
import { EventLog } from '../EventLog/EventLogService'
import {
	type ActiveModel,
	type AgentFinishedLogEntry,
	type CompactionLogEntry,
	type LogSeq,
	LogEntryInputs,
} from '../EventLog/Schemas'
import { type AgentId, type SessionId, Ids } from '../Ids'
import { SessionAlreadyStartedError, SessionNotStartedError } from './Errors'

/** Input for starting the one session owned by this Session instance. */
export type StartSessionInput = {
	/** Host working directory recorded on `session_started`; omit (or pass null) on hosts without a filesystem. */
	readonly cwd?: string | null
	readonly model: ActiveModel
	readonly promptCacheKey?: string
	/** One leading system block, an ordered set of blocks (one system message each), or null for none. */
	readonly systemPrompt: ReadonlyArray<string> | null
	readonly meta?: Readonly<Record<string, Schema.Json>>
	/** Pre-minted session id (hosts that name the log location by session id - D5); defaults to fresh. */
	readonly sessionId?: SessionId
}

/** Identity minted by `start`: the session and its root agent. */
export type StartedSession = {
	readonly sessionId: SessionId
	readonly rootAgentId: AgentId
}

/** Input for switching the root agent to a different model (a new epoch - D17). */
export type SwitchSessionModelInput = {
	readonly model: ActiveModel
	/** The agent's own prompt blocks, recomposed with the new model family's base prompt. */
	readonly systemPrompt: ReadonlyArray<string> | null
	readonly reason?: string | null
}

export type CompactSessionOptions = {
	readonly additionalInstructions?: string | null
}

/**
 * Public SDK facade for one session.
 *
 * `start` appends `session_started` as the first durable row and starts the root agent; a second call
 * fails with `SessionAlreadyStartedError`. `adopt` claims the same slot WITHOUT any durable writes -
 * the resume path (slice 2): identity comes from a replayed `session_started`, and the log continues
 * where it left off. `send` runs one user turn on the root agent and resolves with the durable
 * `agent-finished` entry; a call before `start`/`adopt` fails with `SessionNotStartedError`.
 * `switchModel` writes the D17 epoch transition for the root agent (`model-change`, recomposed leading
 * `system-message`, `tools-change`); callers still provide/swap the LanguageModel for the new provider.
 * `events` merges durable log rows with ephemeral deltas into one error-free stream.
 */
export type SessionService = {
	readonly start: (input: StartSessionInput) => Effect.Effect<StartedSession, SessionAlreadyStartedError>
	readonly adopt: (input: StartedSession) => Effect.Effect<StartedSession, SessionAlreadyStartedError>
	readonly send: (input: { readonly text: string }) => Effect.Effect<AgentFinishedLogEntry, SessionNotStartedError>
	readonly switchModel: (input: SwitchSessionModelInput) => Effect.Effect<void, SessionNotStartedError>
	readonly compact: (
		options?: CompactSessionOptions,
	) => Effect.Effect<CompactionLogEntry | null, SessionNotStartedError>
	readonly events: (fromSeq?: LogSeq) => Stream.Stream<FoldEvent>
}

/** Session service tag. One provided instance represents one session. */
export class Session extends Context.Service<Session, SessionService>()('fold/Session', {
	/** Wires EventLog, Ids, AgentRuntime, and AgentEvents into the public facade. */
	make: Effect.gen(function* () {
		const eventLog = yield* EventLog
		const ids = yield* Ids
		const agentRuntime = yield* AgentRuntime
		const agentEvents = yield* AgentEvents

		// One provided Session owns exactly one session; null until `start` claims the slot.
		const startedRef = yield* Ref.make<StartedSession | null>(null)

		const start: SessionService['start'] = Effect.fn('fold.session.start')((input: StartSessionInput) =>
			Effect.gen(function* () {
				const sessionId = input.sessionId ?? (yield* ids.makeSessionId)
				const rootAgentId = yield* ids.makeAgentId
				const candidate: StartedSession = { sessionId, rootAgentId }

				// Atomically claim the single session slot. `previous` is the prior occupant: null means we won
				// the claim, non-null means the session was already started. Claiming before the durable appends
				// keeps a concurrent double-start from writing a second `session_started` row.
				const previous = yield* Ref.modify(
					startedRef,
					(current): readonly [StartedSession | null, StartedSession | null] =>
						current === null ? [null, candidate] : [current, current],
				)

				if (previous !== null) {
					return yield* new SessionAlreadyStartedError({
						message: 'session already started',
						sessionId: previous.sessionId,
					})
				}

				// `session_started` is the first durable row and carries the freshly minted root agent id.
				yield* eventLog
					.append(
						LogEntryInputs['session_started']({
							agentId: null,
							parentAgentId: null,
							toolCallId: null,
							cwd: input.cwd ?? null,
							sessionId,
							rootAgentId,
							meta: input.meta ?? {},
						}),
					)
					.pipe(Effect.orDie)

				yield* agentRuntime.start({
					agentId: rootAgentId,
					parentAgentId: null,
					toolCallId: null,
					mode: 'fresh',
					fork: null,
					skill: null,
					agentType: null,
					model: input.model,
					promptCacheKey: input.promptCacheKey ?? null,
					systemPrompt: input.systemPrompt,
				})

				return candidate
			}),
		)

		// Adoption is the resume path (slice 2): the identity comes from a replayed `session_started`, so
		// claiming the slot writes NOTHING - the log already carries its first rows.
		const adopt: SessionService['adopt'] = Effect.fn('fold.session.adopt')((input: StartedSession) =>
			Effect.gen(function* () {
				const previous = yield* Ref.modify(
					startedRef,
					(current): readonly [StartedSession | null, StartedSession | null] =>
						current === null ? [null, input] : [current, current],
				)

				if (previous !== null) {
					return yield* new SessionAlreadyStartedError({
						message: 'session already started',
						sessionId: previous.sessionId,
					})
				}

				return input
			}),
		)

		const send: SessionService['send'] = Effect.fn('fold.session.send')((input: { readonly text: string }) =>
			Effect.gen(function* () {
				const started = yield* Ref.get(startedRef)

				if (started === null) {
					return yield* new SessionNotStartedError({ message: 'session not started' })
				}

				return yield* agentRuntime.run({
					agentId: started.rootAgentId,
					parentAgentId: null,
					toolCallId: null,
					messages: [input.text],
				})
			}),
		)

		const switchModel: SessionService['switchModel'] = Effect.fn('fold.session.switch_model')(
			(input: SwitchSessionModelInput) =>
				Effect.gen(function* () {
					const started = yield* Ref.get(startedRef)

					if (started === null) {
						return yield* new SessionNotStartedError({ message: 'session not started' })
					}

					yield* agentRuntime.switchModel({
						agentId: started.rootAgentId,
						parentAgentId: null,
						toolCallId: null,
						model: input.model,
						systemPrompt: input.systemPrompt,
						reason: input.reason ?? null,
					})
				}),
		)

		const compact: SessionService['compact'] = Effect.fn('fold.session.compact')((options) =>
			Effect.gen(function* () {
				const started = yield* Ref.get(startedRef)

				if (started === null) {
					return yield* new SessionNotStartedError({ message: 'session not started' })
				}

				return yield* agentRuntime.compact({
					agentId: started.rootAgentId,
					parentAgentId: null,
					toolCallId: null,
					trigger: 'manual',
					additionalInstructions: options?.additionalInstructions ?? null,
				})
			}),
		)

		// Durable rows replay from `fromSeq` and then follow; the EventLogError channel dies (infrastructure
		// failure), leaving an error-free stream merged with the live ephemeral deltas.
		const events: SessionService['events'] = (fromSeq?: LogSeq) =>
			eventLog.subscribe(fromSeq).pipe(
				Stream.map((entry): FoldEvent => ({ kind: 'log', entry })),
				Stream.orDie,
				Stream.merge(agentEvents.subscribe),
			)

		return { start, adopt, send, switchModel, compact, events }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)

	/** Initialize a fresh log or resume an existing one. The handle lives in the caller's scope. */
	static open<RA = never, RP = never>(options: OpenSessionOptions<RA, RP>) {
		return openSession(options)
	}
}
