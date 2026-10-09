import { expect, it } from '@effect/vitest'
import { Cause, Context, Effect, Exit, Layer, Predicate, Ref, Stream } from 'effect'

import { defineAgent, EventLog, layerInMemoryEventLog, Session, SessionId } from '../../src/index'
import { textTurn } from '../TestLayers/ScriptedLanguageModel'
import { gptActiveModel, scriptedModel } from './ApiTestHelpers'

it.effect('one provided layer is shared by open, send, and host log readers', () =>
	Effect.gen(function* () {
		const log = yield* EventLog
		const { model } = yield* scriptedModel(gptActiveModel, [textTurn('answer')])
		const session = yield* Session.open({ agent: defineAgent({ model }), cwd: '/original', meta: { fresh: true } })
		yield* session.send('hello')
		expect(yield* Stream.runCollect(log.entries())).toEqual(yield* session.entries)
		expect((yield* session.entries).filter(Predicate.isTagged('session_started'))).toHaveLength(1)
	}).pipe(Effect.provide(layerInMemoryEventLog), Effect.scoped),
)

it.effect('host-owned backend survives session scopes and is acquired and released once', () =>
	Effect.gen(function* () {
		const acquired = yield* Ref.make(0)
		const released = yield* Ref.make(0)
		const backend = Layer.effect(
			EventLog,
			Effect.gen(function* () {
				yield* Ref.update(acquired, (n) => n + 1)
				const context = yield* Layer.build(layerInMemoryEventLog)
				return yield* Effect.acquireRelease(Effect.succeed(Context.get(context, EventLog)), () =>
					Ref.update(released, (n) => n + 1),
				)
			}),
		)
		yield* Effect.gen(function* () {
			const log = yield* EventLog
			const { model } = yield* scriptedModel(gptActiveModel, [textTurn('first'), textTurn('second')])
			const agent = defineAgent({ model })
			const firstId = yield* Effect.scoped(
				Effect.gen(function* () {
					const session = yield* Session.open({ agent })
					yield* session.send('first')
					return session.sessionId
				}),
			)
			expect(yield* Ref.get(released)).toBe(0)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const resumed = yield* Session.open({ agent })
					expect(resumed.sessionId).toBe(firstId)
					yield* resumed.send('second')
				}),
			)
			expect(
				(yield* Stream.runCollect(log.entries())).filter(Predicate.isTagged('session_started')),
			).toHaveLength(1)
			expect(yield* Ref.get(released)).toBe(0)
		}).pipe(Effect.provide(backend))
		expect(yield* Ref.get(acquired)).toBe(1)
		expect(yield* Ref.get(released)).toBe(1)
	}).pipe(Effect.scoped),
)

it.effect('reopening preserves recorded metadata and rejects a conflicting identity without writing', () =>
	Effect.gen(function* () {
		const { model } = yield* scriptedModel(gptActiveModel, [])
		const agent = defineAgent({ model })
		const first = yield* Effect.scoped(Session.open({ agent, cwd: '/original', meta: { original: true } }))
		const log = yield* EventLog
		const before = yield* Stream.runCollect(log.entries())
		const resumed = yield* Session.open({
			agent,
			cwd: '/ignored',
			meta: { ignored: true },
			sessionId: first.sessionId,
		})
		expect(yield* resumed.entries).toEqual(before)
		const exit = yield* Session.open({ agent, sessionId: SessionId.create() }).pipe(Effect.exit)
		if (!Exit.isFailure(exit)) throw new Error('expected identity conflict')
		expect(String(Cause.squash(exit.cause))).toContain('conflicts')
		expect(yield* Stream.runCollect(log.entries())).toEqual(before)
	}).pipe(Effect.provide(layerInMemoryEventLog), Effect.scoped),
)

it.effect('nonempty history without session identity is rejected, not initialized', () =>
	Effect.gen(function* () {
		const log = yield* EventLog
		yield* log.append({
			_tag: 'session_title',
			agentId: null,
			parentAgentId: null,
			toolCallId: null,
			title: 'orphan',
		})
		const { model } = yield* scriptedModel(gptActiveModel, [])
		const exit = yield* Session.open({ agent: defineAgent({ model }) }).pipe(Effect.exit)
		if (!Exit.isFailure(exit)) throw new Error('expected invalid log')
		expect(String(Cause.squash(exit.cause))).toContain('nonempty log')
		expect(yield* Stream.runCollect(log.entries())).toHaveLength(1)
	}).pipe(Effect.provide(layerInMemoryEventLog), Effect.scoped),
)

it.effect('a log containing multiple session starts is rejected without appending', () =>
	Effect.gen(function* () {
		const { model } = yield* scriptedModel(gptActiveModel, [])
		const agent = defineAgent({ model })
		const first = yield* Effect.scoped(Session.open({ agent }))
		const log = yield* EventLog
		yield* log.append({
			_tag: 'session_started',
			agentId: null,
			parentAgentId: null,
			toolCallId: null,
			cwd: null,
			meta: {},
			sessionId: first.sessionId,
			rootAgentId: first.rootAgentId,
		})
		const before = yield* Stream.runCollect(log.entries())
		const exit = yield* Session.open({ agent }).pipe(Effect.exit)
		if (!Exit.isFailure(exit)) throw new Error('expected duplicate session identity rejection')
		expect(String(Cause.squash(exit.cause))).toContain('one session_started')
		expect(yield* Stream.runCollect(log.entries())).toEqual(before)
	}).pipe(Effect.provide(layerInMemoryEventLog), Effect.scoped),
)
