import { it, expect } from '@effect/vitest'
import { Effect, Fiber, Layer, Stream } from 'effect'

import { EventLog, EventLogInvalidEntryError, Ids, layerMemory, type LogEntryInput } from '../../src/index'
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime'

const testLayer = Layer.mergeAll(layerMemory, layerDeterministicRuntime({ startMillis: 1_000, stepMillis: 0 }))

const makeSessionStarted = (cwd: string): Effect.Effect<LogEntryInput, never, Ids> =>
	Effect.gen(function* () {
		const ids = yield* Ids

		return {
			_tag: 'session_started',
			agentId: null,
			parentAgentId: null,
			toolCallId: null,
			version: 1,
			cwd,
			sessionId: yield* ids.makeSessionId,
			rootAgentId: yield* ids.makeAgentId,
			meta: {},
		}
	})

it.effect('memory append assigns canonical seq and timestamp', () =>
	Effect.gen(function* () {
		const entries = yield* Effect.gen(function* () {
			const log = yield* EventLog
			const first = yield* log.append(yield* makeSessionStarted('/tmp/one'))
			const second = yield* log.append(yield* makeSessionStarted('/tmp/two'))

			return [first, second] as const
		}).pipe(Effect.provide(testLayer))

		expect(entries[0].seq).toBe(0)
		expect(entries[1].seq).toBe(1)
		expect(entries[0].ts).toBe(1_000)
		expect(entries[1].ts).toBe(1_000)
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
				.append({ ...(yield* makeSessionStarted('/tmp/bad')), version: 2 } as unknown as LogEntryInput)
				.pipe(Effect.flip)
		}).pipe(Effect.provide(testLayer))

		expect(error).toBeInstanceOf(EventLogInvalidEntryError)
	}),
)
