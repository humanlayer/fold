/**
 * The chat routes against an in-memory ChatSessions: each session is fold's in-memory EventLog, so the
 * routes encode and decode real log entries without a Durable Object or a model. The fake mirrors the
 * real contract's shape - the first send to an id clones its repos and starts its session - and echoes the
 * delivery mode so tests can see what the routes passed. A repo whose URL ends in `/missing` fails to clone.
 */
import { it } from '@effect/vitest'
import {
	customModel,
	defineAgent,
	Session,
	EventLog,
	LogEntry,
	SessionId,
	layerInMemoryEventLog,
	type EventLogService,
	type LogEntryInput,
} from '@humanlayer/fold-core'
import { Context, Effect, Layer, Predicate, Ref, Schema, Scope, Stream } from 'effect'
import { LanguageModel } from 'effect/ai'
import { HttpRouter } from 'effect/http'
import { expect } from 'vitest'

import { ChatRoutes } from '../src/Api'
import { ChatSessions } from '../src/ChatSessions'
import { RepoCloneError, repoName } from '../src/Workspace'

const apiTestAgent = defineAgent({
	model: customModel({
		activeModel: {
			providerId: 'test',
			providerKind: 'openai-compatible',
			modelId: 'test',
			role: null,
			requestedReasoningLevel: 'off',
			reasoning: { _tag: 'disabled' },
		},
		make: LanguageModel.make({
			generateText: () => Effect.die('API test does not call a model'),
			streamText: () => Stream.empty,
		}),
	}),
})

const layerInMemory = Layer.effect(
	ChatSessions,
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const logs = yield* Ref.make<ReadonlyMap<SessionId, EventLogService>>(new Map())

		const logFor = (sessionId: SessionId) =>
			Effect.gen(function* () {
				const existing = (yield* Ref.get(logs)).get(sessionId)
				if (existing !== undefined) return existing
				const opened = yield* Layer.build(layerInMemoryEventLog.pipe(Layer.fresh)).pipe(
					Effect.map(Context.get(EventLog)),
					Scope.provide(scope),
				)
				yield* Ref.update(logs, (current) => new Map(current).set(sessionId, opened))
				return opened
			})

		const entriesOf = (log: EventLogService) => Stream.runCollect(log.entries()).pipe(Effect.orDie)
		const appendOrDie = (log: EventLogService, input: LogEntryInput) => Effect.orDie(log.append(input))

		return ChatSessions.of({
			entries: (sessionId) => Effect.flatMap(logFor(sessionId), entriesOf),
			send: (sessionId, { text, whenRunning, repos = [] }) =>
				Effect.gen(function* () {
					const log = yield* logFor(sessionId)
					if ((yield* entriesOf(log)).length === 0) {
						const missing = repos.find((repo) => repo.url.endsWith('/missing'))
						if (missing !== undefined) {
							return yield* new RepoCloneError({ message: `Cloning ${repoName(missing)} failed` })
						}
						// Layer composition at the host boundary supplies the same log to Fold and RPC readers.
						yield* Session.open({
							agent: apiTestAgent,
							sessionId,
							cwd: '/workspace',
							meta: { repos: repos.map(repoName) },
						}).pipe(Effect.provideService(EventLog, log), Scope.provide(scope))
					}
					const identity = (yield* entriesOf(log)).find(Predicate.isTagged('session_started'))
					if (identity === undefined || !Predicate.isTagged(identity, 'session_started'))
						return yield* Effect.die('missing session identity')
					const finished = yield* appendOrDie(log, {
						_tag: 'agent-finished',
						agentId: identity.rootAgentId,
						parentAgentId: null,
						toolCallId: null,
						outcome: 'completed',
						resultText: `${whenRunning}: ${text}`,
						reason: null,
					})
					if (Predicate.isTagged(finished, 'agent-finished')) return finished
					return yield* Effect.die(`appended ${finished._tag} while appending agent-finished`)
				}),
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

it.effect('the first message to a new id starts its session; GET /log replays it', () =>
	Effect.gen(function* () {
		const request = yield* serve
		const sessionId = SessionId.create()

		expect(yield* request('GET', `/sessions/${sessionId}/log`).pipe(Effect.flatMap(decodeEntries))).toEqual([])

		const sent = yield* request('POST', `/sessions/${sessionId}/messages`, { text: 'hi' })
		expect(sent.status).toBe(200)
		expect(yield* Effect.promise(() => sent.json())).toMatchObject({
			_tag: 'agent-finished',
			resultText: 'queue: hi',
		})

		const entries = yield* request('GET', `/sessions/${sessionId}/log`).pipe(Effect.flatMap(decodeEntries))
		expect(entries.filter(Predicate.isTagged('session_started'))).toHaveLength(1)
		expect(entries.at(-1)?._tag).toBe('agent-finished')
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

		expect((yield* request('GET', '/sessions/not-a-session/log')).status).toBe(400)
		expect((yield* request('POST', messages, { message: 'hi' })).status).toBe(400)
		expect((yield* request('POST', messages, { text: 'hi', whenRunning: 'later' })).status).toBe(400)
		expect((yield* request('GET', '/nope')).status).toBe(404)
		expect((yield* request('GET', `/sessions/${SessionId.create()}`)).status).toBe(404)
	}).pipe(Effect.scoped),
)

it.effect('a new session clones the repos its first message names', () =>
	Effect.gen(function* () {
		const request = yield* serve
		const sessionId = SessionId.create()

		const sent = yield* request('POST', `/sessions/${sessionId}/messages`, {
			text: 'hi',
			repos: [
				{ url: 'https://github.com/humanlayer/fold.git' },
				{ url: 'https://github.com/x/y', name: 'other' },
			],
		})
		expect(sent.status).toBe(200)

		const [started] = yield* request('GET', `/sessions/${sessionId}/log`).pipe(Effect.flatMap(decodeEntries))
		expect(started).toMatchObject({
			_tag: 'session_started',
			cwd: '/workspace',
			meta: { repos: ['fold', 'other'] },
		})
	}).pipe(Effect.scoped),
)

it.effect('a repo that fails to clone is a 422 and starts nothing', () =>
	Effect.gen(function* () {
		const request = yield* serve
		const sessionId = SessionId.create()

		const sent = yield* request('POST', `/sessions/${sessionId}/messages`, {
			text: 'hi',
			repos: [{ url: 'https://github.com/x/missing' }],
		})
		expect(sent.status).toBe(422)
		expect(yield* Effect.promise(() => sent.text())).toBe('Cloning missing failed')
		expect(yield* request('GET', `/sessions/${sessionId}/log`).pipe(Effect.flatMap(decodeEntries))).toEqual([])
	}).pipe(Effect.scoped),
)

it.effect('rejects repos that are not https or whose directory names are invalid or repeated', () =>
	Effect.gen(function* () {
		const request = yield* serve
		const send = (repos: ReadonlyArray<unknown>) =>
			request('POST', `/sessions/${SessionId.create()}/messages`, { text: 'hi', repos }).pipe(
				Effect.map((response) => response.status),
			)

		expect(yield* send([{ url: 'git@github.com:x/y.git' }])).toBe(400)
		expect(yield* send([{ url: 'https://github.com/x/y', name: 'a b' }])).toBe(400)
		expect(yield* send([{ url: 'https://github.com/x/y', name: '..' }])).toBe(400)
		expect(yield* send([{ url: 'https://github.com/a/y' }, { url: 'https://github.com/b/y.git' }])).toBe(400)
	}).pipe(Effect.scoped),
)
