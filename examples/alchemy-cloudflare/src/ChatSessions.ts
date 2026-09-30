/**
 * The fold chat sessions this host serves, each addressed by its SessionId. There is no create step:
 * the first `send` to an id starts that session. The Worker implements this as RPC to the ChatSession
 * Durable Object holding each session.
 */
import type { AgentFinishedLogEntry, LogEntry, SessionId } from '@humanlayer/fold-core'
import { Context, Effect, Layer, Schema } from 'effect'

import ChatSession from './ChatSession'

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

export class ChatSessions extends Context.Service<
	ChatSessions,
	{
		/** Every durable log entry of the session so far; empty for an id nothing was sent to. */
		readonly entries: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<LogEntry>>
		/**
		 * Deliver one user message to the session's root agent, starting the session if it is new, and
		 * resolve with the `agent-finished` entry of the run that consumed it.
		 */
		readonly send: (
			sessionId: SessionId,
			text: string,
			whenRunning: WhenRunning,
		) => Effect.Effect<AgentFinishedLogEntry>
	}
>()('alchemy-cloudflare/ChatSessions') {
	/** Each session is the ChatSession Durable Object named by its id. Build it in a Worker's construction. */
	static readonly layer = Layer.effect(
		ChatSessions,
		Effect.gen(function* () {
			const sessions = yield* ChatSession

			return ChatSessions.of({
				entries: (sessionId) => sessions.getByName(sessionId).entries(),
				send: (sessionId, text, whenRunning) => sessions.getByName(sessionId).send(text, whenRunning),
			})
		}),
	)
}
