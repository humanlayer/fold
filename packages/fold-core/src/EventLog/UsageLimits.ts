import { Schema } from 'effect'

/** Percentage (0-100) of a subscription usage-limit window consumed. Best-effort; providers may omit it. */
export const UsageLimitPercent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })).annotate({
	identifier: 'UsageLimitPercent',
})
export type UsageLimitPercent = typeof UsageLimitPercent.Type

/** Nominal length of a usage-limit window in minutes (300 for a 5-hour window, 10080 for a 7-day window). */
export const UsageLimitWindowMinutes = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
	identifier: 'UsageLimitWindowMinutes',
})
export type UsageLimitWindowMinutes = typeof UsageLimitWindowMinutes.Type

/** Epoch milliseconds at which a usage-limit window resets. */
export const UsageLimitResetsAt = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
	identifier: 'UsageLimitResetsAt',
})
export type UsageLimitResetsAt = typeof UsageLimitResetsAt.Type

/** One usage-limit window; read its duration from `windowMinutes`, not the map key, since window positions are not fixed durations. */
export const UsageLimitWindow = Schema.Struct({
	usedPercent: Schema.optional(UsageLimitPercent),
	windowMinutes: Schema.optional(UsageLimitWindowMinutes),
	resetsAt: Schema.optional(UsageLimitResetsAt),
}).annotate({ identifier: 'UsageLimitWindow' })
export type UsageLimitWindow = typeof UsageLimitWindow.Type

/** Prepaid credit / overage state that can offset a reached usage limit. */
export const UsageLimitCredits = Schema.Struct({
	hasCredits: Schema.optional(Schema.Boolean),
	unlimited: Schema.optional(Schema.Boolean),
	balance: Schema.optional(Schema.String),
}).annotate({ identifier: 'UsageLimitCredits' })
export type UsageLimitCredits = typeof UsageLimitCredits.Type

/** Durable, provider-neutral usage-limit snapshot. Best-effort like {@link UsageEncoded}: every field is optional and a reader tolerates an empty snapshot. */
export const UsageLimits = Schema.Struct({
	limitId: Schema.optional(Schema.String),
	limitName: Schema.optional(Schema.String),
	windows: Schema.Record(Schema.String, UsageLimitWindow),
	credits: Schema.optional(UsageLimitCredits),
}).annotate({ identifier: 'UsageLimits' })
export type UsageLimits = typeof UsageLimits.Type

/** Decode an unknown value into a {@link UsageLimits}, yielding `None` when it does not conform. */
export const decodeUsageLimits = Schema.decodeUnknownOption(UsageLimits)
