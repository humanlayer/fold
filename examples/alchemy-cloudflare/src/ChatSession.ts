/**
 * One fold session per Durable Object, named by its SessionId. The object's SQLite log is the session:
 * addressing a new id creates the object with an empty log, and its first `send` starts the session
 * under that id; a written log resumes on activation. Callers never create a session explicitly.
 *
 * Every turn runs under a {@link Keepalive} lease so the object is not evicted mid-run. A turn can still
 * be cut off - a crash, a deploy - leaving the root's user message with no finished run after it. When a
 * written log activates in that state, the object nudges the root to continue.
 * Fold fills any tool call the cut left without a result, and the model can resume a cut-off subagent
 * by id itself. A turn that keeps getting cut off stops being nudged after {@link MAX_RESTART_NUDGES}.
 */
import {
	SessionId,
	type AgentId,
	type FoldSession,
	type LogEntry,
	type UserMessageLogEntry,
	defineAgent,
	eventLogSource,
	openaiModel,
	resumeSession,
	startSession,
} from '@humanlayer/fold-core'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Config, Effect, Match, Option, Predicate, Result, Schema, Scope, Stream } from 'effect'

import type { WhenRunning } from './ChatSessions'
import { DurableObjectEventLog } from './DurableObjectEventLog'
import { Keepalive } from './Keepalive'

const MODEL = 'gpt-5.6-terra'

const RESTART_NUDGE =
	'<system-information>A restart cut you off before you finished. Continue where you left off.</system-information>'
const MAX_RESTART_NUDGES = 3

/** The root's user messages since its last finished run: any means a restart cut that run off. */
const openRootMessages = (entries: ReadonlyArray<LogEntry>, rootAgentId: AgentId) => {
	const lastFinishedSeq =
		entries.findLast((entry) => Predicate.isTagged(entry, 'agent-finished') && entry.agentId === rootAgentId)
			?.seq ?? -1
	return entries.filter(
		(entry): entry is UserMessageLogEntry =>
			Predicate.isTagged(entry, 'user-message') && entry.agentId === rootAgentId && entry.seq > lastFinishedSeq,
	)
}

const isRestartNudge = ({ message }: UserMessageLogEntry) =>
	typeof message.content === 'string'
		? message.content === RESTART_NUDGE
		: message.content.some((part) => part.type === 'text' && part.text === RESTART_NUDGE)

/** The root's next `agent-finished` at or after `fromSeq`: the end of the run a steered message joined. */
const rootFinishedFrom = (session: FoldSession, fromSeq: number) =>
	session.events(fromSeq).pipe(
		Stream.filterMap((event) =>
			event.kind === 'log' &&
			Predicate.isTagged(event.entry, 'agent-finished') &&
			event.entry.agentId === session.rootAgentId
				? Result.succeed(event.entry)
				: Result.fail(event),
		),
		Stream.runHead,
		Effect.flatMap(Effect.fromOption),
		Effect.orDie,
	)

/**
 * Deliver one message to the root agent per {@link WhenRunning}. Idle roots just start a run. Only a
 * subagent target can be missing, so fold's `SubagentNotFoundError` cannot happen here.
 */
const deliver = (session: FoldSession, text: string, whenRunning: WhenRunning) =>
	Match.value(whenRunning).pipe(
		Match.when('queue', () => session.send(text)),
		Match.when('interrupt', () => Effect.andThen(session.interrupt(), session.send(text))),
		Match.when('steer', () =>
			Effect.gen(function* () {
				const fromSeq = (yield* session.entries).length
				yield* session.steer(text)
				return yield* rootFinishedFrom(session, fromSeq)
			}).pipe(Effect.catchTag('AgentNotRunningError', () => session.send(text))),
		),
		Match.exhaustive,
		Effect.catchTag('SubagentNotFoundError', (error) => Effect.die(error)),
	)

export default class ChatSession extends Cloudflare.DurableObject<ChatSession>()(
	'ChatSession',
	Effect.gen(function* () {
		const state = yield* Cloudflare.DurableObjectState
		// Read from the deploy environment and bound to the Worker as a secret. Missing, the deploy fails.
		const apiKey = yield* Config.redacted('OPENAI_API_KEY').pipe(Effect.orDie)
		const eventLogs = yield* DurableObjectEventLog
		const keepalive = yield* Keepalive

		return Effect.gen(function* () {
			const sessionId = yield* Schema.decodeUnknownEffect(SessionId)(state.id.name)
			const eventLog = yield* eventLogs.open
			const log = eventLogSource(Effect.succeed(eventLog))
			const isEmpty = Option.isNone(yield* Stream.runHead(eventLog.entries()))

			const agent = defineAgent({
				name: 'alchemy-cloudflare-chat',
				systemPrompt: 'You are a helpful, concise assistant.',
				model: openaiModel({ apiKey, model: MODEL, reasoning: 'medium' }),
			})

			// Never closed: the session lives as long as the object stays in memory, past every call's own
			// scope. Opened on the first send, so reading an unknown id writes nothing.
			const scope = yield* Scope.make()
			const session = yield* Effect.cached(
				(isEmpty ? startSession({ agent, log, sessionId }) : resumeSession({ agent, log })).pipe(
					Scope.provide(scope),
				),
			)

			// A written log may hold a turn a restart cut off: nudge the root to continue it, in the background
			// under a lease so the heartbeat keeps the object alive until it lands - even when that heartbeat's
			// alarm is the only thing that woke the object.
			if (!isEmpty) {
				yield* Effect.forkIn(
					Effect.gen(function* () {
						const opened = yield* session
						const open = openRootMessages(yield* opened.entries, opened.rootAgentId)
						if (open.length === 0 || open.filter(isRestartNudge).length >= MAX_RESTART_NUDGES) return
						yield* keepalive.whileRunning(deliver(opened, RESTART_NUDGE, 'queue'))
					}),
					scope,
				)
			}

			return {
				send: (text: string, whenRunning: WhenRunning) =>
					keepalive.whileRunning(Effect.flatMap(session, (opened) => deliver(opened, text, whenRunning))),
				entries: () => Stream.runCollect(eventLog.entries()).pipe(Effect.orDie),
				alarm: () => keepalive.alarm,
			}
		}).pipe(Effect.orDie)
	}).pipe(Effect.provide([DurableObjectEventLog.layer, Keepalive.layer])),
) {}
