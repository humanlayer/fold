import { describe, expect, it } from '@effect/vitest'
import { Option } from 'effect'

import { decodeUsageLimits } from '../../src/EventLog/UsageLimits'

describe('decodeUsageLimits', () => {
	it('accepts a best-effort snapshot with sparse windows', () => {
		const decoded = decodeUsageLimits({
			limitId: 'codex',
			windows: {
				primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1704069000000 },
				secondary: { resetsAt: 1704074400000 },
			},
		})

		expect(Option.getOrThrow(decoded).windows.secondary).toEqual({ resetsAt: 1704074400000 })
	})

	it('accepts an empty windows map', () => {
		expect(Option.isSome(decodeUsageLimits({ windows: {} }))).toBe(true)
	})

	it('rejects a percentage outside 0-100', () => {
		expect(Option.isNone(decodeUsageLimits({ windows: { primary: { usedPercent: 150 } } }))).toBe(true)
	})

	it('rejects a non-positive window duration', () => {
		expect(Option.isNone(decodeUsageLimits({ windows: { primary: { windowMinutes: 0 } } }))).toBe(true)
	})
})
