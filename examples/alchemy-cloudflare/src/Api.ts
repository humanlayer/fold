/**
 * The chat HTTP routes over {@link ChatSessions}, encoding responses with fold's log schemas.
 *
 * - `POST /sessions/:sessionId/messages` with `{ "text": string, "whenRunning"?: "queue" | "steer" |
 *   "interrupt", "repos"?: [{ "url": string, "name"?: string, "ref"?: string }] }` delivers one user
 *   message and returns the `agent-finished` entry of the run that consumed it. `whenRunning` defaults to
 *   `queue`. A message to a new id clones its `repos` into `/workspace/<name>` and starts the session;
 *   if a repo fails to clone the response is a 422 and nothing starts.
 * - `GET /sessions/:sessionId/log` returns the session's fold event log.
 */
import { AgentFinishedLogEntry, LogEntry, SessionId } from '@humanlayer/fold-core'
import { Effect, Schema } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { ChatSessions, Message } from './ChatSessions'

const SessionParams = Schema.Struct({ sessionId: SessionId })
const entriesJson = HttpServerResponse.schemaJson(Schema.Array(LogEntry))
const finishedJson = HttpServerResponse.schemaJson(AgentFinishedLogEntry)

const badRequest = () => Effect.succeed(HttpServerResponse.text('Bad request', { status: 400 }))

export const ChatRoutes = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const sessions = yield* ChatSessions

		yield* router.add(
			'GET',
			'/sessions/:sessionId/log',
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
				const message = yield* HttpServerRequest.schemaBodyJson(Message)
				return yield* finishedJson(yield* sessions.send(sessionId, message))
			}).pipe(
				Effect.catchTags({
					SchemaError: badRequest,
					RepoCloneError: ({ message }) => Effect.succeed(HttpServerResponse.text(message, { status: 422 })),
				}),
			),
		)
	}),
)
