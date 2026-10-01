import { describe, expect, it } from '@effect/vitest'
import { Option } from 'effect'
import { Headers } from 'effect/unstable/http'

import { usageLimitsFromCodexHeaders } from '../src/index'

describe('usageLimitsFromCodexHeaders', () => {
	it('parses the default codex primary and secondary windows', () => {
		const headers = Headers.fromInput({
			'x-codex-primary-used-percent': '12.5',
			'x-codex-primary-window-minutes': '300',
			'x-codex-primary-reset-at': '1704069000',
			'x-codex-secondary-used-percent': '80',
			'x-codex-secondary-window-minutes': '10080',
			'x-codex-secondary-reset-at': '1704074400',
		})

		const limits = usageLimitsFromCodexHeaders(headers)
		expect(Option.isSome(limits)).toBe(true)
		expect(Option.getOrThrow(limits)).toEqual({
			limitId: 'codex',
			windows: {
				primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1704069000000 },
				secondary: { usedPercent: 80, windowMinutes: 10080, resetsAt: 1704074400000 },
			},
		})
	})

	it('scales the reset-at header from epoch seconds to epoch milliseconds', () => {
		const headers = Headers.fromInput({
			'x-codex-primary-used-percent': '5',
			'x-codex-primary-reset-at': '1704069000',
		})

		const limits = Option.getOrThrow(usageLimitsFromCodexHeaders(headers))
		expect(limits.windows.primary?.resetsAt).toBe(1704069000000)
	})

	it('keeps a window when only used-percent is present', () => {
		const headers = Headers.fromInput({ 'x-codex-primary-used-percent': '42' })

		expect(Option.getOrThrow(usageLimitsFromCodexHeaders(headers)).windows).toEqual({
			primary: { usedPercent: 42 },
		})
	})

	it('carries the limit name and credit snapshot when present', () => {
		const headers = Headers.fromInput({
			'x-codex-primary-used-percent': '10',
			'x-codex-limit-name': 'gpt-6-astra',
			'x-codex-credits-has-credits': 'true',
			'x-codex-credits-unlimited': 'false',
			'x-codex-credits-balance': '12.34',
		})

		expect(Option.getOrThrow(usageLimitsFromCodexHeaders(headers))).toEqual({
			limitId: 'codex',
			limitName: 'gpt-6-astra',
			windows: { primary: { usedPercent: 10 } },
			credits: { hasCredits: true, unlimited: false, balance: '12.34' },
		})
	})

	it('returns None when no rate-limit headers are present', () => {
		const headers = Headers.fromInput({ 'content-type': 'text/event-stream' })
		expect(Option.isNone(usageLimitsFromCodexHeaders(headers))).toBe(true)
	})

	it('drops unparsable and out-of-range values instead of failing', () => {
		const headers = Headers.fromInput({
			'x-codex-primary-used-percent': 'not-a-number',
			'x-codex-primary-window-minutes': '-3',
			'x-codex-primary-reset-at': '1704069000',
			'x-codex-secondary-used-percent': '150',
		})

		expect(Option.getOrThrow(usageLimitsFromCodexHeaders(headers))).toEqual({
			limitId: 'codex',
			windows: { primary: { resetsAt: 1704069000000 } },
		})
	})
})
