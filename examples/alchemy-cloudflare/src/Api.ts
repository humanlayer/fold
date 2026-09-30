/**
 * The chat HTTP routes over {@link ChatSessions}, encoding responses with fold's log schemas.
 *
 * - `POST /sessions/:sessionId/messages` with `{ "text": string, "whenRunning"?: "queue" | "steer" |
 *   "interrupt" }` delivers one user message, starting the session if the id is new, and returns the
 *   `agent-finished` entry of the run that consumed it. `whenRunning` defaults to `queue`.
 * - `GET /sessions/:sessionId` returns the session's log entries.
 */
import { AgentFinishedLogEntry, LogEntry, SessionId } from '@humanlayer/fold-core'
import { Effect, Schema } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'

import { ChatSessions, WhenRunning } from './ChatSessions'

const SessionParams = Schema.Struct({ sessionId: SessionId })
const MessageBody = Schema.Struct({
	text: Schema.String,
	whenRunning: WhenRunning.pipe(Schema.withDecodingDefaultKey(Effect.succeed('queue'))),
})
const entriesJson = HttpServerResponse.schemaJson(Schema.Array(LogEntry))
const finishedJson = HttpServerResponse.schemaJson(AgentFinishedLogEntry)

const badRequest = () => Effect.succeed(HttpServerResponse.text('Bad request', { status: 400 }))

export const ChatRoutes = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const sessions = yield* ChatSessions

		yield* router.add(
			'GET',
			'/sessions/:sessionId',
			Effect.gen(function* () {
				const { sessionId } = yield* HttpRouter.schemaPathParams(SessionParams)
				return yield* entriesJson(yield* sessions.entries(sessionId))
			}).pipe(Effect.catchTag('SchemaError', badRequest)),
		)

		yield* router.add(
			'POST',
			'/sessions/:sessionId/messages',
			Effect.gen(function* () {
				const { sessionId } = yield* HttpRouter.schemaPathParams(SessionParams)
				const { text, whenRunning } = yield* HttpServerRequest.schemaBodyJson(MessageBody)
				return yield* finishedJson(yield* sessions.send(sessionId, text, whenRunning))
			}).pipe(Effect.catchTag('SchemaError', badRequest)),
		)
	}),
)
