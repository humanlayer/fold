import { SessionId } from '@humanlayer/fold-core'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { relativeSessionTime, shortSessionId } from '../../src/tui/SessionPickerState'

describe('TUI session picker formatting', () => {
	it('uses a compact display id without losing the typed full id at the data boundary', () => {
		const sessionId = Schema.decodeUnknownSync(SessionId)('sess_abcdefghijklmnopqrstuvwx')

		expect(shortSessionId(sessionId)).toBe('sess_abcdef')
	})

	it('formats recent session modification times at useful human scales', () => {
		const now = 1_000_000_000

		expect(relativeSessionTime(now - 30_000, now)).toBe('now')
		expect(relativeSessionTime(now - 5 * 60_000, now)).toBe('5m ago')
		expect(relativeSessionTime(now - 3 * 60 * 60_000, now)).toBe('3h ago')
		expect(relativeSessionTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago')
	})
})
