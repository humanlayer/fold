/**
 * The chat routes against an in-memory ChatSessions: each session is fold's in-memory EventLog, so the
 * routes encode and decode real log entries without a Durable Object or a model. The fake mirrors the
 * real contract's shape - the first send to an id starts its session - and echoes the delivery mode so
 * tests can see what the routes passed.
 */
import { it } from '@effect/vitest'
import {
	AgentId,
	EventLog,
	LogEntry,
	SessionId,
	layerInMemoryEventLog,
	type EventLogService,
} from '@humanlayer/fold-core'
import { Context, Effect, Layer, Predicate, Ref, Schema, Scope, Stream } from 'effect'
import { HttpRouter } from 'effect/unstable/http'
import { expect } from 'vitest'

import { ChatRoutes } from '../src/Api'
import { ChatSessions } from '../src/ChatSessions'

const rootAgentId = AgentId.create()

const layerInMemory = Layer.effect(
	ChatSessions,
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const logs = yield* Ref.make<ReadonlyMap<SessionId, EventLogService>>(new Map())

		const logFor = (sessionId: SessionId) =>
			Effect.gen(function* () {
				const existing = (yield* Ref.get(logs)).get(sessionId)
				if (existing !== undefined) return existing
				const opened = yield* Layer.build(layerInMemoryEventLog).pipe(
					Effect.map(Context.get(EventLog)),
					Scope.provide(scope),
				)
				yield* Ref.update(logs, (current) => new Map(current).set(sessionId, opened))
				return opened
			})

		const entriesOf = (log: EventLogService) => Stream.runCollect(log.entries()).pipe(Effect.orDie)

		return ChatSessions.of({
			entries: (sessionId) => Effect.flatMap(logFor(sessionId), entriesOf),
			send: (sessionId, text, whenRunning) =>
				Effect.gen(function* () {
					const log = yield* logFor(sessionId)
					if ((yield* entriesOf(log)).length === 0) {
						yield* log.append({
							_tag: 'session_started',
							agentId: null,
							parentAgentId: null,
							toolCallId: null,
							cwd: null,
							sessionId,
							rootAgentId,
							meta: {},
						})
					}
					const finished = yield* log.append({
						_tag: 'agent-finished',
						agentId: rootAgentId,
						parentAgentId: null,
						toolCallId: null,
						outcome: 'completed',
						resultText: `${whenRunning}: ${text}`,
						reason: null,
					})
					if (Predicate.isTagged(finished, 'agent-finished')) return finished
					return yield* Effect.die(`appended ${finished._tag} while appending agent-finished`)
				}).pipe(Effect.orDie),
		})
	}),
)

/** One handler over a fresh in-memory ChatSessions, disposed with the test scope. */
const serve = Effect.acquireRelease(
	Effect.sync(() => HttpRouter.toWebHandler(ChatRoutes.pipe(Layer.provide(layerInMemory)), { disableLogger: true })),
	({ dispose }) => Effect.promise(dispose),
).pipe(
	Effect.map(({ handler }) => (method: string, path: string, body?: unknown) => {
		const init: RequestInit = { method }
		if (body !== undefined) {
			init.body = JSON.stringify(body)
			init.headers = { 'content-type': 'application/json' }
		}
		return Effect.promise(() => handler(new Request(`http://chat.test${path}`, init)))
	}),
)

const decodeEntries = (response: Response) =>
	Effect.promise(() => response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LogEntry))))

it.effect('the first message to a new id starts its session; GET replays it', () =>
	Effect.gen(function* () {
		const request = yield* serve
		const sessionId = SessionId.create()

		expect(yield* request('GET', `/sessions/${sessionId}`).pipe(Effect.flatMap(decodeEntries))).toEqual([])

		const sent = yield* request('POST', `/sessions/${sessionId}/messages`, { text: 'hi' })
		expect(sent.status).toBe(200)
		expect(yield* Effect.promise(() => sent.json())).toMatchObject({
			_tag: 'agent-finished',
			resultText: 'queue: hi',
		})

		const entries = yield* request('GET', `/sessions/${sessionId}`).pipe(Effect.flatMap(decodeEntries))
		expect(entries.map((entry) => entry._tag)).toEqual(['session_started', 'agent-finished'])
	}).pipe(Effect.scoped),
)

it.effect('passes an explicit whenRunning through', () =>
	Effect.gen(function* () {
		const request = yield* serve

		const sent = yield* request('POST', `/sessions/${SessionId.create()}/messages`, {
			text: 'stop that',
			whenRunning: 'interrupt',
		})
		expect(yield* Effect.promise(() => sent.json())).toMatchObject({ resultText: 'interrupt: stop that' })
	}).pipe(Effect.scoped),
)

it.effect('rejects bad ids, bodies, and modes', () =>
	Effect.gen(function* () {
		const request = yield* serve
		const messages = `/sessions/${SessionId.create()}/messages`

		expect((yield* request('GET', '/sessions/not-a-session')).status).toBe(400)
		expect((yield* request('POST', messages, { message: 'hi' })).status).toBe(400)
		expect((yield* request('POST', messages, { text: 'hi', whenRunning: 'later' })).status).toBe(400)
		expect((yield* request('GET', '/nope')).status).toBe(404)
	}).pipe(Effect.scoped),
)
