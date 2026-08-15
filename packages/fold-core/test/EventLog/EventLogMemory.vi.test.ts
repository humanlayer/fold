import { it, expect } from '@effect/vitest'
import { Effect, Fiber, Layer, Stream } from 'effect'

import {
	EventId,
	EventLog,
	EventLogInvalidEntryError,
	Ids,
	layerInMemoryEventLogWithIds,
	makeStoredLogEntry,
	type LogEntryInput,
} from '../../src/index'
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime'

const runtimeLayer = layerDeterministicRuntime({ startMillis: 1_000, stepMillis: 0 })
const testLayer = Layer.mergeAll(layerInMemoryEventLogWithIds.pipe(Layer.provide(runtimeLayer)), runtimeLayer)

const makeSessionStarted = (cwd: string): Effect.Effect<LogEntryInput, never, Ids> =>
	Effect.gen(function* () {
		const ids = yield* Ids

		return {
			_tag: 'session_started',
			agentId: null,
			parentAgentId: null,
			toolCallId: null,
			cwd,
			sessionId: yield* ids.makeSessionId,
			rootAgentId: yield* ids.makeAgentId,
			meta: {},
		}
	})

it.effect('the ID service creates branded event IDs', () =>
	Effect.gen(function* () {
		const ids = yield* Ids
		expect(EventId.is(yield* ids.makeEventId)).toBe(true)
	}).pipe(Effect.provide(testLayer)),
)

it.effect('stored entries use the supplied event ID service', () =>
	Effect.gen(function* () {
		const eventId = EventId.make('event_aaaaaaaaaaaaaaaaaaaaaaaa')
		const entry = yield* makeStoredLogEntry(yield* makeSessionStarted('/tmp/one'), 0, {
			makeEventId: Effect.succeed(eventId),
		})

		expect(entry.eventId).toBe(eventId)
	}).pipe(Effect.provide(testLayer)),
)

it.effect('memory append assigns canonical sequence, event identity, and timestamp', () =>
	Effect.gen(function* () {
		const entries = yield* Effect.gen(function* () {
			const log = yield* EventLog
			const first = yield* log.append(yield* makeSessionStarted('/tmp/one'))
			const second = yield* log.append(yield* makeSessionStarted('/tmp/two'))

			return [first, second] as const
		}).pipe(Effect.provide(testLayer))

		expect(entries[0].seq).toBe(0)
		expect(entries[1].seq).toBe(1)
		expect(EventId.is(entries[0].eventId)).toBe(true)
		expect(EventId.is(entries[1].eventId)).toBe(true)
		expect(entries[0].eventId).not.toBe(entries[1].eventId)
		expect(entries[0].ts).toBe(1_000)
		expect(entries[1].ts).toBe(1_000)
		expect(entries[0].version).toBe(1)
		expect(entries[1].version).toBe(1)
	}),
)

it.effect('memory entries replay stored entries and complete', () =>
	Effect.gen(function* () {
		const result = yield* Effect.gen(function* () {
			const log = yield* EventLog
			yield* log.append(yield* makeSessionStarted('/tmp/one'))
			yield* log.append(yield* makeSessionStarted('/tmp/two'))

			return yield* Stream.runCollect(log.entries())
		}).pipe(Effect.provide(testLayer))

		expect(result.map((entry) => entry.seq)).toEqual([0, 1])
	}),
)

it.effect('memory entries can replay from a sequence', () =>
	Effect.gen(function* () {
		const result = yield* Effect.gen(function* () {
			const log = yield* EventLog
			yield* log.append(yield* makeSessionStarted('/tmp/one'))
			yield* log.append(yield* makeSessionStarted('/tmp/two'))

			return yield* Stream.runCollect(log.entries(1))
		}).pipe(Effect.provide(testLayer))

		expect(result.map((entry) => entry.seq)).toEqual([1])
	}),
)

it.effect('memory subscribe replays and follows live appends', () =>
	Effect.gen(function* () {
		const result = yield* Effect.gen(function* () {
			const log = yield* EventLog
			yield* log.append(yield* makeSessionStarted('/tmp/one'))

			const fiber = yield* Stream.runCollect(log.subscribe(0).pipe(Stream.take(2))).pipe(Effect.forkChild)
			yield* log.append(yield* makeSessionStarted('/tmp/two'))

			return yield* Fiber.join(fiber)
		}).pipe(Effect.provide(testLayer))

		expect(result.map((entry) => entry.seq)).toEqual([0, 1])
	}),
)

it.effect('memory append maps invalid input to EventLogInvalidEntryError', () =>
	Effect.gen(function* () {
		const error = yield* Effect.gen(function* () {
			const log = yield* EventLog
			return yield* log
				.append(
					// Intentionally invalid input: this test exercises append's schema-validation failure path.
					// oxlint-disable-next-line typescript/consistent-type-assertions
					{ ...(yield* makeSessionStarted('/tmp/bad')), cwd: 42 } as unknown as LogEntryInput,
				)
				.pipe(Effect.flip)
		}).pipe(Effect.provide(testLayer))

		expect(error).toBeInstanceOf(EventLogInvalidEntryError)
	}),
)
