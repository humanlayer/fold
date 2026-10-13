import { TerminalControl } from '@kitlangton/terminal-control'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let terminal: TerminalControl
const terminalDescribe = process.env.FOLD_TUI_TERMINAL_TEST === '1' ? describe.sequential : describe.skip

terminalDescribe('TUI background subagents', () => {
	beforeAll(async () => {
		terminal = await TerminalControl.make()
	})

	afterAll(async () => {
		await terminal.close()
	})

	it('shows background agents in the rail, the wake as a notification row, and stops one with x', async () => {
		await using session = await terminal.launch({
			command: ['bun', '--preload', '@opentui/solid/preload', 'test/fixtures/TuiBackgroundFixture.tsx'],
			cwd: import.meta.dirname.replace(/\/test$/, ''),
			host: 'opentui',
			viewport: { cols: 160, rows: 44 },
			record: 'on-failure',
		})

		await session.screen.waitForText('The test audit is done.', { timeoutMs: 10_000 })
		await session.keyboard.type('l')
		await session.keyboard.type('l')
		await session.keyboard.press('Tab')
		await session.keyboard.press('Tab')
		await session.screen.waitForText('find the config loader', { timeoutMs: 10_000 })
		const frame = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(frame.text).toContain('AGENTS')
		expect(frame.text).toContain('Background agent "audit the tests" completed')
		expect(frame.text).not.toContain('<task-notification>')
		expect(frame.text).toContain('1 RUN · 1 BG')
		expect(frame.text).toContain('BG')

		await session.keyboard.type('a')
		await session.screen.waitForText('X STOP', { timeoutMs: 10_000 })
		await session.keyboard.type('x')
		await session.screen.waitForText('BACKGROUND AGENT STOPPED', { timeoutMs: 10_000 })
		await session.screen.waitForText('0 RUN', { timeoutMs: 10_000 })
	}, 60_000)
})
