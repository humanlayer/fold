/**
 * Stream hardening for the unstable Codex backend (D23): a first-event ("no headers/no first token")
 * timeout, an idle-without-productive-event timeout, and bounded jittered-exponential retry of
 * first-event stalls. Semantics and defaults are ported from agentlayer's SSE vendor route: only
 * first-event stalls are retried - nothing has been emitted downstream yet, so a silent re-subscribe
 * cannot duplicate content - while an idle stall after partial output fails the stream honestly (the
 * turn-level restart with a `stream-retry` delta is the loop's future integration, D23). Timeouts
 * measure producer latency per pull: the deadline arms when the consumer asks for the next event and
 * clears when one arrives, so consumer-side processing time never counts against the stream.
 */
import { Duration, Effect, Random, Stream } from 'effect'
import { AiError } from 'effect/unstable/ai'

/** `AiError.module` value marking errors minted by this package. */
export const CODEX_ERROR_MODULE = 'tart-codex'

const FIRST_EVENT_METHOD = 'streamText.firstEventTimeout'
const IDLE_METHOD = 'streamText.idleTimeout'

/** Stall-timeout and retry configuration for one Codex model. */
export type CodexHardeningOptions = {
	/** Max wait for the first stream event after the request is issued. */
	readonly firstEventTimeoutMs: number
	/** How many times a first-event stall is retried (total attempts = retries + 1). */
	readonly firstEventTimeoutRetries: number
	readonly firstEventRetryBaseDelayMs: number
	readonly firstEventRetryMaxDelayMs: number
	/** Max gap between two stream events mid-stream. Idle stalls are not retried. */
	readonly eventIdleTimeoutMs: number
}

/** agentlayer's production Codex values. */
export const defaultCodexHardening: CodexHardeningOptions = {
	firstEventTimeoutMs: 60_000,
	firstEventTimeoutRetries: 3,
	firstEventRetryBaseDelayMs: 1_000,
	firstEventRetryMaxDelayMs: 10_000,
	eventIdleTimeoutMs: 120_000,
}

/** One retry notification: `attempt` is the attempt about to run (1-based over the retries budget). */
export type StreamRetryInfo = {
	readonly attempt: number
	readonly delayMs: number
	readonly error: AiError.AiError
}

const stallError = (method: string, description: string): AiError.AiError =>
	AiError.make({
		module: CODEX_ERROR_MODULE,
		method,
		reason: new AiError.InternalProviderError({ description }),
	})

/**
 * The first-event stall error for the request-acquisition phase (request sent, no response yet).
 * Classified identically to a stream first-event stall so both phases share one retry policy.
 */
export const codexAcquisitionStallError = (timeoutMs: number): AiError.AiError =>
	stallError(
		FIRST_EVENT_METHOD,
		`No response received within ${timeoutMs}ms of sending the request (codex first-event timeout)`,
	)

/** True for the first-event stall errors this package mints (the only retryable stall class). */
export const isCodexFirstEventStall = (error: unknown): error is AiError.AiError =>
	error instanceof AiError.AiError && error.module === CODEX_ERROR_MODULE && error.method === FIRST_EVENT_METHOD

/** True for the mid-stream idle stall errors this package mints. */
export const isCodexIdleStall = (error: unknown): error is AiError.AiError =>
	error instanceof AiError.AiError && error.module === CODEX_ERROR_MODULE && error.method === IDLE_METHOD

/**
 * Bound the stream's producer latency: the first event must arrive within `firstEventTimeoutMs` and
 * every later event within `eventIdleTimeoutMs` of the previous pull, or the stream fails with a
 * typed stall error. Firing a timeout interrupts the in-flight pull, which tears down the underlying
 * HTTP request through its scope finalizers.
 */
export const withStallTimeouts =
	(options: Pick<CodexHardeningOptions, 'firstEventTimeoutMs' | 'eventIdleTimeoutMs'>) =>
	<A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E | AiError.AiError, R> =>
		Stream.transformPull(self, (pull, _scope) =>
			Effect.sync(() => {
				let seenFirstEvent = false

				return Effect.suspend(() => {
					const timeoutMs = seenFirstEvent ? options.eventIdleTimeoutMs : options.firstEventTimeoutMs
					const method = seenFirstEvent ? IDLE_METHOD : FIRST_EVENT_METHOD
					const description = seenFirstEvent
						? `No stream event received for ${timeoutMs}ms mid-stream (codex idle timeout)`
						: `No stream event received within ${timeoutMs}ms of the request (codex first-event timeout)`

					return pull.pipe(
						Effect.timeoutOrElse({
							duration: Duration.millis(timeoutMs),
							orElse: () => Effect.fail(stallError(method, description)),
						}),
						Effect.map((chunk) => {
							seenFirstEvent = true
							return chunk
						}),
					)
				})
			}),
		)

/** The jittered exponential retry delay (agentlayer's formula: `min(base * 2^attempt, max)` ±20%). */
export const firstEventRetryDelayMs = (
	options: Pick<CodexHardeningOptions, 'firstEventRetryBaseDelayMs' | 'firstEventRetryMaxDelayMs'>,
	attempt: number,
): Effect.Effect<number> => {
	const max = options.firstEventRetryMaxDelayMs
	const target = Math.min(options.firstEventRetryBaseDelayMs * 2 ** attempt, max)

	return Random.nextBetween(Math.min(target * 0.8, max), Math.min(target * 1.2, max)).pipe(Effect.map(Math.round))
}

/** Options for {@link withFirstEventRetry} / {@link hardenCodexStream}. */
export type CodexRetryOptions = CodexHardeningOptions & {
	/** Observes each retry (the future AgentEvents `stream-retry` seam). Defaults to a log warning. */
	readonly onStreamRetry?: (info: StreamRetryInfo) => Effect.Effect<void>
}

const defaultOnStreamRetry = (info: StreamRetryInfo): Effect.Effect<void> =>
	Effect.logWarning(
		`Codex stream produced no first event; retrying (attempt ${info.attempt}) in ${info.delayMs}ms: ${info.error.message}`,
	)

/**
 * Retry first-event stalls with bounded jittered-exponential backoff. Each retry re-runs `makeAttempt`
 * from scratch - a fresh subscription and a fresh HTTP request. Only first-event stalls retry; every
 * other failure (idle stalls included) propagates immediately.
 */
export const withFirstEventRetry = <A, E, R>(
	makeAttempt: () => Stream.Stream<A, E, R>,
	options: CodexRetryOptions,
): Stream.Stream<A, E, R> => {
	const onStreamRetry = options.onStreamRetry ?? defaultOnStreamRetry

	const attempt = (n: number): Stream.Stream<A, E, R> =>
		makeAttempt().pipe(
			Stream.catch((error) => {
				if (!isCodexFirstEventStall(error) || n >= options.firstEventTimeoutRetries) {
					return Stream.fail(error)
				}

				return Stream.unwrap(
					firstEventRetryDelayMs(options, n).pipe(
						Effect.tap((delayMs) => onStreamRetry({ attempt: n + 1, delayMs, error })),
						Effect.flatMap((delayMs) => Effect.sleep(Duration.millis(delayMs))),
						Effect.map(() => attempt(n + 1)),
					),
				)
			}),
		)

	return attempt(0)
}

/** Stall timeouts + first-event retry composed: the full Codex hardening pipeline for one request. */
export const hardenCodexStream = <A, E, R>(
	makeAttempt: () => Stream.Stream<A, E, R>,
	options: CodexRetryOptions,
): Stream.Stream<A, E | AiError.AiError, R> =>
	withFirstEventRetry<A, E | AiError.AiError, R>(() => makeAttempt().pipe(withStallTimeouts(options)), options)
