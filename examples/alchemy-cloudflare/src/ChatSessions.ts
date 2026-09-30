/**
 * The fold chat sessions this host serves, each addressed by its SessionId. There is no create step:
 * the first `send` to an id clones its repos and starts that session. The Worker implements this as RPC to
 * the ChatSession Durable Object holding each session.
 */
import type { AgentFinishedLogEntry, LogEntry, SessionId } from '@humanlayer/fold-core'
import { Context, Effect, Layer, Schema } from 'effect'

import ChatSession from './ChatSession'
import { RepoCloneError, Repos } from './Workspace'

/**
 * What `send` does when the session's root agent is already running. When it is idle, every mode just
 * starts a run.
 *
 * - `queue`: fold's follow-up - the message joins the running run when it would otherwise finish.
 * - `steer`: fold's steering - the message lands between the running run's turns.
 * - `interrupt`: interrupt the running run (fold writes its interrupted markers), then start a new one.
 */
export const WhenRunning = Schema.Literals(['queue', 'steer', 'interrupt'])
export type WhenRunning = typeof WhenRunning.Type

/**
 * One user message. `repos` clone into the session's workspace when the message starts the session; later
 * messages' `repos` are ignored.
 */
export const Message = Schema.Struct({
	text: Schema.String,
	whenRunning: WhenRunning.pipe(Schema.withDecodingDefaultKey(Effect.succeed('queue'))),
	repos: Schema.optionalKey(Repos),
})
export type Message = typeof Message.Type

export class ChatSessions extends Context.Service<
	ChatSessions,
	{
		/** Every durable log entry of the session so far; empty for an id nothing was sent to. */
		readonly entries: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<LogEntry>>
		/**
		 * Deliver one user message to the session's root agent, starting the session if it is new, and
		 * resolve with the `agent-finished` entry of the run that consumed it. Fails, starting nothing, when a
		 * new session's repo does not clone.
		 */
		readonly send: (sessionId: SessionId, message: Message) => Effect.Effect<AgentFinishedLogEntry, RepoCloneError>
	}
>()('alchemy-cloudflare/ChatSessions') {
	/** Each session is the ChatSession Durable Object named by its id. Build it in a Worker's construction. */
	static readonly layer = Layer.effect(
		ChatSessions,
		Effect.gen(function* () {
			const sessions = yield* ChatSession

			return ChatSessions.of({
				entries: (sessionId) => sessions.getByName(sessionId).entries(),
				// The object's failures arrive encoded: decode the clone failure, and die on anything else.
				send: (sessionId, message) =>
					sessions
						.getByName(sessionId)
						.send(message)
						.pipe(
							Effect.catch((error) =>
								Schema.decodeUnknownEffect(RepoCloneError)(error).pipe(
									Effect.orDie,
									Effect.flatMap(Effect.fail),
								),
							),
						),
			})
		}),
	)
}
