import { TerminalControl } from '@kitlangton/terminal-control'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let terminal: TerminalControl
const terminalDescribe = process.env.FOLD_TUI_TERMINAL_TEST === '1' ? describe.sequential : describe.skip

terminalDescribe('TUI staged model selection', () => {
	beforeAll(async () => {
		terminal = await TerminalControl.make()
	})
	afterAll(async () => {
		await terminal.close()
	})

	it('chooses profile and direct launches and reaches active selection with Ctrl-K', async () => {
		await using session = await terminal.launch({
			command: [
				'bun',
				'--preload',
				'@opentui/solid/preload',
				`${import.meta.dirname}/fixtures/TuiModelSelectionFixture.tsx`,
			],
			cwd: import.meta.dirname.replace(/\/test$/, ''),
			host: 'opentui',
			viewport: { cols: 110, rows: 30 },
			record: 'on-failure',
		})
		await session.screen.waitForText('MODEL SELECTION', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('fixture-profile', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('"profile":"fixture-profile"', { timeoutMs: 10_000 })
		await session.screen.waitForText('Direct model', { timeoutMs: 10_000 })
		await session.keyboard.press('ArrowDown')
		await session.keyboard.press('Enter')
		await session.screen.waitForText('fixture-provider', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('fixture-model', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('Mode · new session only', { timeoutMs: 10_000 })
		await session.keyboard.press('ArrowDown')
		await session.keyboard.press('Enter')
		await session.screen.waitForText('"mode":"rlm"', { timeoutMs: 10_000 })
		await session.keyboard.type('\u000b')
		await session.screen.waitForText('Selection type', { timeoutMs: 10_000 })
		const screen = await session.screen.capture({ settleMs: 50, deadlineMs: 2_000, allowIncomplete: true })
		expect(screen.text).toContain('MODEL SELECTION')
	}, 30_000)

	it('hands keyboard control from directory input to model selection', async () => {
		await using session = await terminal.launch({
			command: [
				'bun',
				'--preload',
				'@opentui/solid/preload',
				`${import.meta.dirname}/fixtures/TuiNewSessionModelFixture.tsx`,
			],
			cwd: import.meta.dirname.replace(/\/test$/, ''),
			host: 'opentui',
			viewport: { cols: 110, rows: 30 },
			record: 'on-failure',
		})

		await session.screen.waitForText('Working directory', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('Selection type', { timeoutMs: 10_000 })
		await session.keyboard.press('ArrowDown')
		await session.screen.waitForText('▸ Direct model', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('Provider', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('Model · fixture-provider', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('Mode · new session only', { timeoutMs: 10_000 })
		await session.keyboard.press('ArrowDown')
		await session.keyboard.press('Enter')
		await session.screen.waitForText('"provider":"fixture-provider"', { timeoutMs: 10_000 })
		await session.screen.waitForText('"mode":"rlm"', { timeoutMs: 10_000 })
	}, 30_000)
})
