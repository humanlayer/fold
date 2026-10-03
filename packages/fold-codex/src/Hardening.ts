/**
 * Stream hardening for the unstable Codex backend (D23): a first-event ("no headers/no first token")
 * timeout, an idle-without-productive-event timeout, and bounded jittered-exponential retry of
 * first-event stalls. Semantics and defaults are ported from agentlayer's SSE vendor route: only
 * retryable failures before the first event are retried - nothing has been emitted downstream yet,
 * so a fresh request cannot duplicate content - while an idle stall after partial output fails the
 * stream honestly (the turn-level restart with a `stream-retry` delta is the loop's future
 * integration, D23). Provider RateLimitError values use their Retry-After delay. Timeouts measure
 * producer latency per pull: the deadline arms when the consumer asks for the next event and clears
 * when one arrives, so consumer-side processing time never counts against the stream.
 */
import { Data, Duration, Effect, Match, Option, Random, Stream } from 'effect'
import { AiError } from 'effect/ai'

/** `AiError.module` value marking errors minted by this package. */
export const CODEX_ERROR_MODULE = 'fold-codex'

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

/**
 * Nothing arrived within the first-event window: either the request got no response (`request`) or its
 * stream produced no event (`stream`). Retryable - nothing has reached the consumer yet.
 */
export class CodexFirstEventStall extends Data.TaggedError('CodexFirstEventStall')<{
	readonly phase: 'request' | 'stream'
	readonly timeoutMs: number
}> {
	override get message(): string {
		return this.phase === 'request'
			? `No response received within ${this.timeoutMs}ms of sending the request (codex first-event timeout)`
			: `No stream event received within ${this.timeoutMs}ms of the request (codex first-event timeout)`
	}
}

/** The stream went quiet mid-flight after partial output. Never retried. */
export class CodexIdleStall extends Data.TaggedError('CodexIdleStall')<{
	readonly timeoutMs: number
}> {
	override get message(): string {
		return `No stream event received for ${this.timeoutMs}ms mid-stream (codex idle timeout)`
	}
}

/** The stall failures this package's timeouts raise. */
export type CodexStall = CodexFirstEventStall | CodexIdleStall

/** Every failure a hardened Codex stream can raise before the provider boundary. */
export type CodexStreamError = AiError.AiError | CodexStall

/** One retry notification: `attempt` is the attempt about to run (1-based over the retries budget). */
export type StreamRetryInfo = {
	readonly attempt: number
	readonly delayMs: number
	readonly error: CodexStreamError
}

/**
 * A failure is safe to repeat only before the model has emitted any stream event: a first-event stall
 * or a retryable provider error. Idle stalls are excluded because a fresh request could duplicate
 * content or repeat a tool call that has already reached the agent runtime.
 */
export const isCodexRetryableBeforeFirstEvent: (error: CodexStreamError) => boolean =
	Match.type<CodexStreamError>().pipe(
		Match.tagsExhaustive({
			AiError: (error) => error.isRetryable,
			CodexFirstEventStall: () => true,
			CodexIdleStall: () => false,
		}),
	)

/** The provider's Retry-After delay, when the failure carries one. */
export const codexRetryAfter: (error: CodexStreamError) => Option.Option<Duration.Duration> =
	Match.type<CodexStreamError>().pipe(
		Match.tagsExhaustive({
			AiError: (error) => Option.fromUndefinedOr(error.retryAfter),
			CodexFirstEventStall: () => Option.none(),
			CodexIdleStall: () => Option.none(),
		}),
	)

/**
 * Lower a stall to the `AiError` the OpenAI client contract carries. The `method` keeps first-event and
 * idle stalls distinguishable downstream.
 */
export const codexStallToAiError: (stall: CodexStall) => AiError.AiError = Match.type<CodexStall>().pipe(
	Match.tagsExhaustive({
		CodexFirstEventStall: (stall) =>
			AiError.make({
				module: CODEX_ERROR_MODULE,
				method: 'streamText.firstEventTimeout',
				reason: new AiError.InternalProviderError({ description: stall.message }),
			}),
		CodexIdleStall: (stall) =>
			AiError.make({
				module: CODEX_ERROR_MODULE,
				method: 'streamText.idleTimeout',
				reason: new AiError.InternalProviderError({ description: stall.message }),
			}),
	}),
)

/**
 * Bound the stream's producer latency: the first event must arrive within `firstEventTimeoutMs` and
 * every later event within `eventIdleTimeoutMs` of the previous pull, or the stream fails with a
 * typed stall error. Firing a timeout interrupts the in-flight pull, which tears down the underlying
 * HTTP request through its scope finalizers.
 */
export const withStallTimeouts =
	(options: Pick<CodexHardeningOptions, 'firstEventTimeoutMs' | 'eventIdleTimeoutMs'>) =>
	<A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E | CodexStall, R> =>
		Stream.transformPull(self, (pull, _scope) =>
			Effect.sync(() => {
				let seenFirstEvent = false

				return Effect.suspend(() => {
					const stall: CodexStall = seenFirstEvent
						? new CodexIdleStall({ timeoutMs: options.eventIdleTimeoutMs })
						: new CodexFirstEventStall({ phase: 'stream', timeoutMs: options.firstEventTimeoutMs })

					return pull.pipe(
						Effect.timeoutOrElse({
							duration: Duration.millis(stall.timeoutMs),
							orElse: () => Effect.fail(stall),
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
	retryAfter: Option.Option<Duration.Duration> = Option.none(),
): Effect.Effect<number> => {
	if (Option.isSome(retryAfter)) return Effect.succeed(Duration.toMillis(retryAfter.value))

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
 * Retry retryable failures before the first event with bounded backoff. Each retry re-runs
 * `makeAttempt` from scratch - a fresh subscription and a fresh HTTP request. A provider-provided
 * Retry-After takes precedence over the fallback jittered-exponential delay. Every mid-stream failure
 * propagates immediately.
 */
export const withFirstEventRetry = <A, E extends CodexStreamError, R>(
	makeAttempt: () => Stream.Stream<A, E, R>,
	options: CodexRetryOptions,
): Stream.Stream<A, E, R> => {
	const onStreamRetry = options.onStreamRetry ?? defaultOnStreamRetry

	const attempt = (n: number): Stream.Stream<A, E, R> =>
		Stream.unwrap(
			Effect.sync(() => {
				let emitted = false

				return makeAttempt().pipe(
					Stream.tap(() =>
						Effect.sync(() => {
							emitted = true
						}),
					),
					Stream.catch((error) => {
						if (
							emitted ||
							!isCodexRetryableBeforeFirstEvent(error) ||
							n >= options.firstEventTimeoutRetries
						) {
							return Stream.fail(error)
						}

						return Stream.unwrap(
							firstEventRetryDelayMs(options, n, codexRetryAfter(error)).pipe(
								Effect.tap((delayMs) => onStreamRetry({ attempt: n + 1, delayMs, error })),
								Effect.flatMap((delayMs) => Effect.sleep(Duration.millis(delayMs))),
								Effect.map(() => attempt(n + 1)),
							),
						)
					}),
				)
			}),
		)

	return attempt(0)
}

/**
 * Stall timeouts + first-event retry composed: the full Codex hardening pipeline for one request.
 * Stalls stay typed; lower them with {@link codexStallToAiError} at the provider boundary.
 */
export const hardenCodexStream = <A, E extends AiError.AiError, R>(
	makeAttempt: () => Stream.Stream<A, E, R>,
	options: CodexRetryOptions,
): Stream.Stream<A, E | CodexStall, R> =>
	withFirstEventRetry(() => makeAttempt().pipe(withStallTimeouts(options)), options)
