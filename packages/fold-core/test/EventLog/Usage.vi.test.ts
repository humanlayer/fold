import { describe, expect, it } from '@effect/vitest'
import type { Response } from 'effect/unstable/ai'

import { usageFromResponseUsage } from '../../src/EventLog/Usage'

describe('usageFromResponseUsage', () => {
	it('omits invalid derived token details while preserving provider totals', () => {
		const usage: Response.Usage = {
			inputTokens: {
				uncached: 10,
				total: 10,
				cacheRead: 0,
				cacheWrite: 0,
			},
			outputTokens: {
				total: 8,
				text: -4,
				reasoning: 12,
			},
		}

		expect(usageFromResponseUsage(usage)).toEqual({
			inputTokens: {
				uncached: 10,
				total: 10,
				cacheRead: 0,
				cacheWrite: 0,
			},
			outputTokens: {
				total: 8,
				text: undefined,
				reasoning: 12,
			},
		})
	})
})
