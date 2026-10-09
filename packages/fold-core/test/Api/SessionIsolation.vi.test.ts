import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
/**
 * Cross-session isolation: Session.open builds with session-fresh memo maps, so two sessions started
 * inside one program never share module-level layers. This is the regression test for the v4
 * CurrentMemoMap hazard - it.effect runs under `Effect.provide`, so an ambient memo map is present in
 * the fiber context, which is exactly the environment where by-reference layer memoization would hand
 * both sessions one shared EventLog and one shared event spine.
 */
import { expect, it } from '@effect/vitest'
import { Deferred, Fiber, Predicate, Effect, Stream } from 'effect'

import { defineAgent, Session, type SessionStartedLogEntry } from '../../src/index'
import { textTurn } from '../TestLayers/ScriptedLanguageModel'
import { gptActiveModel, scriptedModel } from './ApiTestHelpers'

it.effect('two sessions in one program share no log, ids, or model runtime', () =>
	Effect.gen(function* () {
		const first = yield* scriptedModel(gptActiveModel, [textTurn('from session A')])
		const second = yield* scriptedModel(gptActiveModel, [textTurn('from session B')])

		const sessionA = yield* Session.open({
			agent: defineAgent({ model: first.model, systemPrompt: 'Session A agent.' }),
		})
		const sessionB = yield* Session.open({
			agent: defineAgent({ model: second.model, systemPrompt: 'Session B agent.' }),
		})

		expect(sessionA.sessionId).not.toBe(sessionB.sessionId)
		expect(sessionA.rootAgentId).not.toBe(sessionB.rootAgentId)

		const finishedA = yield* sessionA.send('hello A')
		const finishedB = yield* sessionB.send('hello B')

		// Each session's runtime reached its own provider exactly once.
		expect(finishedA.resultText).toBe('from session A')
		expect(finishedB.resultText).toBe('from session B')
		expect((yield* first.scripted.requests).length).toBe(1)
		expect((yield* second.scripted.requests).length).toBe(1)

		// Each durable log holds exactly one session - its own. A shared memoized EventLog would put
		// both session_started rows (and both conversations) into one interleaved log.
		const entriesA = yield* sessionA.entries
		const entriesB = yield* sessionB.entries

		const sessionStartsA = entriesA.filter((entry): entry is SessionStartedLogEntry =>
			Predicate.isTagged(entry, 'session_started'),
		)
		const sessionStartsB = entriesB.filter((entry): entry is SessionStartedLogEntry =>
			Predicate.isTagged(entry, 'session_started'),
		)
		expect(sessionStartsA.map((entry) => entry.sessionId)).toEqual([sessionA.sessionId])
		expect(sessionStartsB.map((entry) => entry.sessionId)).toEqual([sessionB.sessionId])

		expect(entriesA.every((entry) => entry.agentId === null || entry.agentId === sessionA.rootAgentId)).toBe(true)
		expect(entriesB.every((entry) => entry.agentId === null || entry.agentId === sessionB.rootAgentId)).toBe(true)

		// Sequence numbers restart per log - interleaving into one shared log would break this.
		expect(entriesA.map((entry) => entry.seq)).toEqual(entriesA.map((_, index) => index))
		expect(entriesB.map((entry) => entry.seq)).toEqual(entriesB.map((_, index) => index))
		const eventIdsA = new Set(entriesA.map((entry) => entry.eventId))
		expect(entriesB.some((entry) => eventIdsA.has(entry.eventId))).toBe(false)

		// The first replayed event proves the subscription is attached before either live append.
		const subscribed = yield* Deferred.make<void>()
		const liveTitle = yield* Effect.forkChild(
			sessionA.events().pipe(
				Stream.tap(() => Deferred.succeed(subscribed, undefined)),
				Stream.filter((event) => event.kind === 'log' && Predicate.isTagged(event.entry, 'session_title')),
				Stream.take(1),
				Stream.runCollect,
			),
		)
		yield* Deferred.await(subscribed)
		yield* sessionB.setTitle('session B title')
		yield* sessionA.setTitle('session A title')
		expect(yield* Fiber.join(liveTitle)).toMatchObject([
			{ kind: 'log', entry: { _tag: 'session_title', title: 'session A title' } },
		])
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)
