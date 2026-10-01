/**
 * Parse the Codex subscription usage-limit headers the ChatGPT backend attaches to every
 * `/responses` reply into fold-core's provider-neutral {@link UsageLimits} snapshot.
 *
 * The backend reports the default `codex` limit family as a flat header set: `x-codex-<position>-`
 * `used-percent`/`window-minutes`/`reset-at` for the `primary` and `secondary` positions, plus a
 * `x-codex-credits-*` group and a `x-codex-limit-name` label. `reset-at` is absolute epoch seconds;
 * fold stores epoch milliseconds, so it is scaled here. Every field is best-effort: a header that is
 * absent, blank, or unparsable is dropped, and a response that carries no window and no credit data
 * yields `None` rather than an empty snapshot.
 */
import { decodeUsageLimits } from '@humanlayer/fold-core'
import type { UsageLimitCredits, UsageLimits, UsageLimitWindow } from '@humanlayer/fold-core'
import { Option } from 'effect'
import { Headers } from 'effect/unstable/http'

const CODEX_LIMIT_ID = 'codex'
const HEADER_PREFIX = `x-${CODEX_LIMIT_ID}`
const WINDOW_POSITIONS = ['primary', 'secondary'] as const

type WindowPosition = (typeof WINDOW_POSITIONS)[number]

const headerString = (headers: Headers.Headers, name: string): string | undefined => {
	const value = Headers.get(headers, name)
	if (Option.isNone(value)) return undefined
	const trimmed = value.value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

const headerNumber = (headers: Headers.Headers, name: string): number | undefined => {
	const raw = headerString(headers, name)
	if (raw === undefined) return undefined
	const parsed = Number(raw)
	return Number.isFinite(parsed) ? parsed : undefined
}

const headerBoolean = (headers: Headers.Headers, name: string): boolean | undefined => {
	const raw = headerString(headers, name)
	if (raw === undefined) return undefined
	if (raw.toLowerCase() === 'true') return true
	if (raw.toLowerCase() === 'false') return false
	return undefined
}

const parseWindow = (headers: Headers.Headers, position: WindowPosition): UsageLimitWindow | undefined => {
	const usedPercent = headerNumber(headers, `${HEADER_PREFIX}-${position}-used-percent`)
	const windowMinutes = headerNumber(headers, `${HEADER_PREFIX}-${position}-window-minutes`)
	const resetAtSeconds = headerNumber(headers, `${HEADER_PREFIX}-${position}-reset-at`)

	const window: { -readonly [Key in keyof UsageLimitWindow]: UsageLimitWindow[Key] } = {}
	if (usedPercent !== undefined && usedPercent >= 0 && usedPercent <= 100) window.usedPercent = usedPercent
	if (windowMinutes !== undefined && Number.isInteger(windowMinutes) && windowMinutes > 0)
		window.windowMinutes = windowMinutes
	if (resetAtSeconds !== undefined && Number.isInteger(resetAtSeconds) && resetAtSeconds >= 0)
		window.resetsAt = resetAtSeconds * 1000

	return Object.keys(window).length > 0 ? window : undefined
}

const parseCredits = (headers: Headers.Headers): UsageLimitCredits | undefined => {
	const hasCredits = headerBoolean(headers, `${HEADER_PREFIX}-credits-has-credits`)
	const unlimited = headerBoolean(headers, `${HEADER_PREFIX}-credits-unlimited`)
	const balance = headerString(headers, `${HEADER_PREFIX}-credits-balance`)

	const credits: { -readonly [Key in keyof UsageLimitCredits]: UsageLimitCredits[Key] } = {}
	if (hasCredits !== undefined) credits.hasCredits = hasCredits
	if (unlimited !== undefined) credits.unlimited = unlimited
	if (balance !== undefined) credits.balance = balance

	return Object.keys(credits).length > 0 ? credits : undefined
}

/**
 * Read the default Codex usage-limit family from one response's headers. Returns `None` when the
 * response carries neither a window nor credit data, so callers only surface real snapshots.
 */
export const usageLimitsFromCodexHeaders = (headers: Headers.Headers): Option.Option<UsageLimits> => {
	const windows: Record<string, UsageLimitWindow> = {}
	for (const position of WINDOW_POSITIONS) {
		const window = parseWindow(headers, position)
		if (window !== undefined) windows[position] = window
	}

	const credits = parseCredits(headers)
	if (Object.keys(windows).length === 0 && credits === undefined) return Option.none()

	const limitName = headerString(headers, `${HEADER_PREFIX}-limit-name`)
	const candidate: Record<string, unknown> = { limitId: CODEX_LIMIT_ID, windows }
	if (limitName !== undefined) candidate.limitName = limitName
	if (credits !== undefined) candidate.credits = credits

	return decodeUsageLimits(candidate)
}
