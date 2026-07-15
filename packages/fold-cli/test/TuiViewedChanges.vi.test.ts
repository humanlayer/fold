import { describe, expect, it } from 'vitest'

import type { GitChange } from '../src/tui/GitChanges'
import { isChangeViewed, markChangeViewed } from '../src/tui/ViewedChanges'

const change = (patchHash: string): GitChange => ({
	key: 'unstaged:src/app.ts',
	group: 'unstaged',
	status: 'M',
	path: 'src/app.ts',
	additions: 1,
	deletions: 0,
	diff: 'patch',
	expandedDiff: 'patch',
	patchHash,
})

describe('viewed changes', () => {
	it('ties viewed state to the latest patch hash', () => {
		const viewed = markChangeViewed({}, change('first'))

		expect(isChangeViewed(viewed, change('first'))).toBe(true)
		expect(isChangeViewed(viewed, change('second'))).toBe(false)
	})
})
