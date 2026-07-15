import { Schema } from 'effect'
import { Response } from 'effect/unstable/ai'

/** Best-effort token count reported by a model provider. Providers may omit any usage field. */
export const UsageTokenCount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
	identifier: 'UsageTokenCount',
})
export type UsageTokenCount = typeof UsageTokenCount.Type

/** Best-effort input-token accounting persisted in the EventLog. */
export const UsageInputTokens = Schema.Struct({
	/** Non-cached input tokens, when the provider reports them directly. */
	uncached: Schema.optional(UsageTokenCount),
	/** Total input tokens, including cache reads/writes when the provider folds them in. */
	total: Schema.optional(UsageTokenCount),
	/** Cached input tokens read, when available. */
	cacheRead: Schema.optional(UsageTokenCount),
	/** Cached input tokens written, when available. */
	cacheWrite: Schema.optional(UsageTokenCount),
}).annotate({ identifier: 'UsageInputTokens' })
export type UsageInputTokens = typeof UsageInputTokens.Type

/** Best-effort output-token accounting persisted in the EventLog. */
export const UsageOutputTokens = Schema.Struct({
	/** Total output tokens, when available. */
	total: Schema.optional(UsageTokenCount),
	/** Text output tokens, when available. */
	text: Schema.optional(UsageTokenCount),
	/** Reasoning output tokens, when available. */
	reasoning: Schema.optional(UsageTokenCount),
}).annotate({ identifier: 'UsageOutputTokens' })
export type UsageOutputTokens = typeof UsageOutputTokens.Type

/**
 * Durable model usage metadata. This is deliberately fold-owned instead of aliasing
 * `Response.Usage`: provider usage details are best-effort, and older logs may omit any field.
 */
export const UsageEncoded = Schema.Struct({
	inputTokens: Schema.optional(UsageInputTokens),
	outputTokens: Schema.optional(UsageOutputTokens),
}).annotate({ identifier: 'UsageEncoded' })
export type UsageEncoded = typeof UsageEncoded.Type

const encodeResponseUsage = Schema.encodeUnknownSync(Response.Usage)
const decodeUsageEncoded = Schema.decodeUnknownSync(UsageEncoded)

/** Convert Effect AI usage into fold's tolerant durable usage shape. */
export const usageFromResponseUsage = (usage: Response.Usage): UsageEncoded =>
	decodeUsageEncoded(encodeResponseUsage(usage))

/** Best estimate of total input tokens from whatever fields the provider reported. */
export const usageInputTotal = (usage: UsageEncoded): number => {
	const input = usage.inputTokens
	if (input === undefined) return 0

	return input.total ?? (input.uncached ?? 0) + (input.cacheRead ?? 0) + (input.cacheWrite ?? 0)
}

/** Best display value for non-cached input tokens, falling back to total input when uncached is absent. */
export const usageInputUncached = (usage: UsageEncoded): number => {
	const input = usage.inputTokens
	if (input === undefined) return 0

	return input.uncached ?? input.total ?? 0
}

/** Cached input tokens read, if the provider reported them. */
export const usageCacheRead = (usage: UsageEncoded): number | undefined => usage.inputTokens?.cacheRead

/** Cached input tokens written, if the provider reported them. */
export const usageCacheWrite = (usage: UsageEncoded): number | undefined => usage.inputTokens?.cacheWrite

/** Total output tokens, defaulting to zero when absent. */
export const usageOutputTotal = (usage: UsageEncoded): number => usage.outputTokens?.total ?? 0
