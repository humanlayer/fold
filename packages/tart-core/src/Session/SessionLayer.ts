/**
 * This file implements the live Session layer - the public facade over AgentRuntime, EventLog, Ids, and
 * AgentEvents. It owns the single session/root-agent identity in a Ref, appends `session_started` as the
 * first durable row, starts the root agent, and exposes `events` as the merge of durable EventLog replay
 * (mapped to `kind: 'log'`) with the ephemeral AgentEvents delta stream.
 */
import { Effect, Layer, Ref, Stream } from 'effect'

import { AgentEvents } from '../AgentEvents/AgentEventsService'
import type { TartEvent } from '../AgentEvents/AgentEventsService'
import { AgentRuntime } from '../AgentRuntime/AgentRuntimeService'
import { EventLog } from '../EventLog/EventLogService'
import type { LogSeq } from '../EventLog/Schemas'
import { Ids } from '../Ids'
import { SessionAlreadyStartedError, SessionNotStartedError } from './Errors'
import {
	Session,
	type SessionService,
	type StartedSession,
	type StartSessionInput,
	type SwitchSessionModelInput,
} from './SessionService'

/** Live Session layer wiring EventLog, Ids, AgentRuntime, and AgentEvents into the public facade. */
export const liveSessionLayer: Layer.Layer<Session, never, EventLog | Ids | AgentRuntime | AgentEvents> = Layer.effect(
	Session,
	Effect.gen(function* () {
		const eventLog = yield* EventLog
		const ids = yield* Ids
		const agentRuntime = yield* AgentRuntime
		const agentEvents = yield* AgentEvents

		// One provided Session owns exactly one session; null until `start` claims the slot.
		const startedRef = yield* Ref.make<StartedSession | null>(null)

		const start: SessionService['start'] = Effect.fn('tart.session.start')((input: StartSessionInput) =>
			Effect.gen(function* () {
				const sessionId = yield* ids.makeSessionId
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
					.append({
						_tag: 'session_started',
						agentId: null,
						parentAgentId: null,
						toolCallId: null,
						version: 1,
						cwd: input.cwd ?? null,
						sessionId,
						rootAgentId,
						meta: input.meta ?? {},
					})
					.pipe(Effect.orDie)

				yield* agentRuntime.start({
					agentId: rootAgentId,
					parentAgentId: null,
					toolCallId: null,
					model: input.model,
					systemPrompt: input.systemPrompt,
				})

				return candidate
			}),
		)

		const send: SessionService['send'] = Effect.fn('tart.session.send')((input: { readonly text: string }) =>
			Effect.gen(function* () {
				const started = yield* Ref.get(startedRef)

				if (started === null) {
					return yield* new SessionNotStartedError({ message: 'session not started' })
				}

				return yield* agentRuntime.run({
					agentId: started.rootAgentId,
					parentAgentId: null,
					toolCallId: null,
					text: input.text,
				})
			}),
		)

		const switchModel: SessionService['switchModel'] = Effect.fn('tart.session.switch_model')(
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

		// Durable rows replay from `fromSeq` and then follow; the EventLogError channel dies (infrastructure
		// failure), leaving an error-free stream merged with the live ephemeral deltas.
		const events: SessionService['events'] = (fromSeq?: LogSeq) =>
			eventLog.subscribe(fromSeq).pipe(
				Stream.map((entry): TartEvent => ({ kind: 'log', entry })),
				Stream.orDie,
				Stream.merge(agentEvents.subscribe),
			)

		return { start, send, switchModel, events, interrupt: Effect.void }
	}),
)
