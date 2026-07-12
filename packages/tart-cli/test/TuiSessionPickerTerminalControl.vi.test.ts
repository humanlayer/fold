import { TerminalControl } from '@kitlangton/terminal-control'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let terminal: TerminalControl
const terminalDescribe = process.env.TART_TUI_TERMINAL_TEST === '1' ? describe.sequential : describe.skip

terminalDescribe('TUI session picker', () => {
	beforeAll(async () => {
		terminal = await TerminalControl.make()
	})

	afterAll(async () => {
		await terminal.close()
	})

	it('opens existing sessions and offers a keyboard-first new-session row', async () => {
		await using session = await terminal.launch({
			command: ['bun', '--preload', '@opentui/solid/preload', 'test/fixtures/TuiSessionPickerFixture.tsx'],
			cwd: import.meta.dirname.replace(/\/test$/, ''),
			host: 'opentui',
			viewport: { cols: 150, rows: 32 },
			record: 'on-failure',
		})

		await session.screen.waitForText('SESSIONS · NEWEST FIRST', { timeoutMs: 10_000 })
		const initial = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(initial.text).toContain('sess_abcdef')
		expect(initial.text).toContain('Fix the flaky CI matrix')
		expect(initial.text).toContain('42%')
		expect(initial.text).toContain('MODE · PROFILE')
		expect(initial.text).toContain('TURNS')
		expect(initial.text).toContain('CONTEXT')
		expect(initial.text).toContain('UPDATED')
		expect(initial.text).toContain('＋ NEW SESSION · HERE')

		await session.keyboard.type('x')
		await session.screen.waitForText('CONFIRM DELETION? (Y/N)', { timeoutMs: 10_000 })
		await session.keyboard.type('n')
		await session.screen.waitForText('Fix the flaky CI matrix', { timeoutMs: 10_000 })
		await session.keyboard.type('x')
		await session.keyboard.type('y')
		await session.screen.waitForText('DELETED sess_abcdefghijklmnopqrstuvwx', { timeoutMs: 10_000 })

		await session.keyboard.press('Enter')
		await session.screen.waitForText('OPENED sess_bcdefghijklmnopqrstuvwxy', { timeoutMs: 10_000 })
		await session.keyboard.press('ArrowDown')
		await session.keyboard.press('Enter')
		await session.screen.waitForText('NEW SESSION SELECTED', { timeoutMs: 10_000 })
		await session.keyboard.type('q')
		const exit = await session.waitForExit({ timeoutMs: 5_000 })
		expect(exit).toMatchObject({ reason: 'exited', exit: { code: 0 } })
	}, 30_000)
})
