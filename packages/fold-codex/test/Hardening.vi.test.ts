import { describe, expect, it } from '@effect/vitest'
import { Deferred, Duration, Effect, Fiber, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { AiError } from 'effect/unstable/ai'

import {
	firstEventRetryDelayMs,
	hardenCodexStream,
	isCodexFirstEventStall,
	isCodexIdleStall,
	withStallTimeouts,
} from '../src/index'
import type { CodexRetryOptions, StreamRetryInfo } from '../src/index'

// Real-clock tests (it.live) with tiny durations: stall timeouts never fire under the TestClock.
const fastOptions = (overrides?: Partial<CodexRetryOptions>): CodexRetryOptions => ({
	firstEventTimeoutMs: 60,
	firstEventTimeoutRetries: 2,
	firstEventRetryBaseDelayMs: 1,
	firstEventRetryMaxDelayMs: 4,
	eventIdleTimeoutMs: 80,
	...overrides,
})

/** A stream that produces nothing, forever. */
const hangingStream = <A = number>(): Stream.Stream<A> => Stream.fromEffect(Effect.never)

/** Emits `head` immediately, then hangs forever. */
const stallAfter = (head: number): Stream.Stream<number> =>
	Stream.make(head).pipe(Stream.concat(hangingStream<number>()))

describe('withStallTimeouts', () => {
	it.live('passes a healthy stream through untouched', () =>
		Effect.gen(function* () {
			const paced = Stream.make(1).pipe(
				Stream.concat(Stream.fromEffect(Effect.sleep(Duration.millis(10)).pipe(Effect.as(2)))),
				Stream.concat(Stream.fromEffect(Effect.sleep(Duration.millis(10)).pipe(Effect.as(3)))),
			)

			const collected = yield* Stream.runCollect(paced.pipe(withStallTimeouts(fastOptions())))
			expect(collected).toEqual([1, 2, 3])
		}),
	)

	it.live('fails with a first-event stall when nothing arrives in time', () =>
		Effect.gen(function* () {
			const error = yield* Stream.runCollect(hangingStream().pipe(withStallTimeouts(fastOptions()))).pipe(
				Effect.flip,
			)

			expect(isCodexFirstEventStall(error)).toBe(true)
			expect(isCodexIdleStall(error)).toBe(false)
			expect(String(error)).toContain('first-event timeout')
		}),
	)

	it.live('fails with an idle stall when the stream hangs mid-flight', () =>
		Effect.gen(function* () {
			const seen: Array<number> = []
			const error = yield* Stream.runForEach(stallAfter(1).pipe(withStallTimeouts(fastOptions())), (value) =>
				Effect.sync(() => {
					seen.push(value)
				}),
			).pipe(Effect.flip)

			expect(seen).toEqual([1])
			expect(isCodexIdleStall(error)).toBe(true)
			expect(isCodexFirstEventStall(error)).toBe(false)
		}),
	)
})

describe('hardenCodexStream', () => {
	it.live('retries a first-event stall and succeeds on a later attempt', () =>
		Effect.gen(function* () {
			let attempts = 0
			const retries: Array<StreamRetryInfo> = []

			const stream = hardenCodexStream(
				() => {
					attempts += 1
					return attempts === 1 ? hangingStream() : Stream.make(1, 2)
				},
				fastOptions({ onStreamRetry: (info) => Effect.sync(() => void retries.push(info)) }),
			)

			const collected = yield* Stream.runCollect(stream)
			expect(collected).toEqual([1, 2])
			expect(attempts).toBe(2)
			expect(retries).toHaveLength(1)
			expect(retries[0]?.attempt).toBe(1)
			expect(isCodexFirstEventStall(retries[0]?.error)).toBe(true)
		}),
	)

	it.live('gives up after the retry budget and fails with the stall', () =>
		Effect.gen(function* () {
			let attempts = 0
			const stream = hardenCodexStream(
				() => {
					attempts += 1
					return hangingStream()
				},
				fastOptions({ firstEventTimeoutRetries: 2 }),
			)

			const error = yield* Stream.runCollect(stream).pipe(Effect.flip)
			expect(isCodexFirstEventStall(error)).toBe(true)
			expect(attempts).toBe(3)
		}),
	)

	it.live('does not retry idle stalls - partial output already reached the consumer', () =>
		Effect.gen(function* () {
			let attempts = 0
			const stream = hardenCodexStream(() => {
				attempts += 1
				return stallAfter(1)
			}, fastOptions())

			const error = yield* Stream.runCollect(stream).pipe(Effect.flip)
			expect(isCodexIdleStall(error)).toBe(true)
			expect(attempts).toBe(1)
		}),
	)

	it.effect('does not retry a rate limit after partial output', () =>
		Effect.gen(function* () {
			let attempts = 0
			const rateLimitError = AiError.make({
				module: 'test',
				method: 'streamText',
				reason: new AiError.RateLimitError({ retryAfter: Duration.millis(1) }),
			})
			const stream = hardenCodexStream(() => {
				attempts += 1
				return Stream.make(1).pipe(Stream.concat(Stream.fail(rateLimitError)))
			}, fastOptions())

			const error = yield* Stream.runCollect(stream).pipe(Effect.flip)
			expect(error).toBe(rateLimitError)
			expect(attempts).toBe(1)
		}),
	)

	it.live('does not retry ordinary provider failures', () =>
		Effect.gen(function* () {
			let attempts = 0
			const boom = new Error('provider exploded')
			const stream = hardenCodexStream(() => {
				attempts += 1
				return Stream.fail(boom)
			}, fastOptions())

			const error = yield* Stream.runCollect(stream).pipe(Effect.flip)
			expect(error).toBe(boom)
			expect(attempts).toBe(1)
		}),
	)

	it.effect('waits for a provider Retry-After before retrying a rate limit', () =>
		Effect.gen(function* () {
			let attempts = 0
			const firstAttempt = yield* Deferred.make<void>()
			const retries: Array<StreamRetryInfo> = []
			const rateLimitError = AiError.make({
				module: 'test',
				method: 'streamText',
				reason: new AiError.RateLimitError({ retryAfter: Duration.seconds(16) }),
			})
			const stream = hardenCodexStream(
				() => {
					attempts += 1
					return attempts === 1
						? Stream.unwrap(
								Deferred.succeed(firstAttempt, undefined).pipe(Effect.as(Stream.fail(rateLimitError))),
							)
						: Stream.make(1)
				},
				fastOptions({ onStreamRetry: (info) => Effect.sync(() => void retries.push(info)) }),
			)

			const fiber = yield* Stream.runCollect(stream).pipe(Effect.forkChild({ startImmediately: true }))
			yield* Deferred.await(firstAttempt)
			yield* TestClock.adjust(Duration.seconds(15))
			expect(attempts).toBe(1)

			yield* TestClock.adjust(Duration.seconds(1))
			expect(yield* Fiber.join(fiber)).toEqual([1])
			expect(attempts).toBe(2)
			expect(retries[0]?.delayMs).toBe(16_000)
		}),
	)
})

describe('firstEventRetryDelayMs', () => {
	it.effect('applies jittered exponential backoff capped at the max delay', () =>
		Effect.gen(function* () {
			const options = { firstEventRetryBaseDelayMs: 1000, firstEventRetryMaxDelayMs: 10_000 }

			const first = yield* firstEventRetryDelayMs(options, 0)
			expect(first).toBeGreaterThanOrEqual(800)
			expect(first).toBeLessThanOrEqual(1200)

			const second = yield* firstEventRetryDelayMs(options, 1)
			expect(second).toBeGreaterThanOrEqual(1600)
			expect(second).toBeLessThanOrEqual(2400)

			// 1000 * 2^4 = 16000 caps at 10000; jitter window collapses to [8000, 10000].
			const capped = yield* firstEventRetryDelayMs(options, 4)
			expect(capped).toBeGreaterThanOrEqual(8000)
			expect(capped).toBeLessThanOrEqual(10_000)
		}),
	)

	it.effect('uses a provider Retry-After unchanged', () =>
		Effect.gen(function* () {
			const delay = yield* firstEventRetryDelayMs(
				{ firstEventRetryBaseDelayMs: 1000, firstEventRetryMaxDelayMs: 10_000 },
				0,
				AiError.make({
					module: 'test',
					method: 'streamText',
					reason: new AiError.RateLimitError({ retryAfter: Duration.seconds(16) }),
				}),
			)

			expect(delay).toBe(16_000)
		}),
	)
})
