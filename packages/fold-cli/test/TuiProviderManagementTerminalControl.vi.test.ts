import { TerminalControl } from '@kitlangton/terminal-control'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let terminal: TerminalControl
const terminalDescribe = process.env.FOLD_TUI_TERMINAL_TEST === '1' ? describe.sequential : describe.skip

terminalDescribe('provider management TUI', () => {
	beforeAll(async () => {
		terminal = await TerminalControl.make()
	})
	afterAll(async () => {
		await terminal.close()
	})

	it('opens from the top-level palette and visibly applies an auth action', async () => {
		await using session = await terminal.launch({
			command: [
				'bun',
				'--preload',
				'@opentui/solid/preload',
				`${import.meta.dirname}/fixtures/TuiProviderManagementFixture.tsx`,
			],
			cwd: import.meta.dirname.replace(/\/test$/, ''),
			host: 'opentui',
			viewport: { cols: 110, rows: 30 },
			record: 'on-failure',
		})
		await session.screen.waitForText('SESSIONS · NEWEST FIRST', { timeoutMs: 10_000 })
		await session.keyboard.type('\u000b')
		await session.screen.waitForText('Providers / Auth...', { timeoutMs: 10_000 })
		await session.keyboard.type('Providers / Auth')
		await session.keyboard.press('Enter')
		await session.screen.waitForText('PROVIDERS / AUTH', { timeoutMs: 10_000 })
		await session.screen.waitForText('xAI OAuth', { timeoutMs: 10_000 })
		await session.keyboard.type('s')
		await session.screen.waitForText('AUTH UPDATED: fixture-xai status', { timeoutMs: 10_000 })
		const screen = await session.screen.capture({ settleMs: 50, deadlineMs: 2_000, allowIncomplete: true })
		expect(screen.text).toContain('AUTH UPDATED: fixture-xai status')
	}, 30_000)
})
