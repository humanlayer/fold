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

	it('routes from picker to the full provider page and back with non-wrapping forms', async () => {
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
		let screen = await session.screen.capture({ settleMs: 50, deadlineMs: 2_000, allowIncomplete: true })
		expect(screen.text).not.toContain('SESSIONS · NEWEST FIRST')
		for (const label of [
			'OpenAI',
			'Anthropic',
			'Codex',
			'Grok',
			'OpenCode Zen / Black',
			'+ Add OpenAI-compatible',
			'+ Add Anthropic-compatible',
		])
			await session.screen.waitForText(label, { timeoutMs: 10_000 })
		expect(screen.text).toContain('BUILT-IN API PROVIDERS')
		expect(screen.text).toContain('OAUTH PROVIDERS')
		expect(screen.text).toContain('COMPATIBLE PROVIDERS')
		expect(screen.text).not.toContain('openai-\ncompat')
		await session.keyboard.press('ArrowDown')
		await session.keyboard.press('ArrowDown')
		await session.screen.waitForText('▸ Codex', { timeoutMs: 10_000 })
		await session.keyboard.type('s')
		await session.screen.waitForText('AUTH UPDATED: codex status', { timeoutMs: 10_000 })
		await session.keyboard.press('ArrowDown')
		await session.keyboard.press('Enter')
		await session.screen.waitForText('▸ Grok', { timeoutMs: 10_000 })
		screen = await session.screen.capture({ settleMs: 50, deadlineMs: 2_000, allowIncomplete: true })
		expect(screen.text).not.toContain('Kind: xai')
		await session.keyboard.type('b')
		await session.screen.waitForText('AUTH UPDATED: xai browser', { timeoutMs: 10_000 })
		await session.keyboard.press('ArrowDown')
		await session.screen.waitForText('▸ OpenCode Zen / Black', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.keyboard.type('d')
		await session.screen.waitForText('AUTH UPDATED: opencode device', { timeoutMs: 10_000 })
		screen = await session.screen.capture({ settleMs: 50, deadlineMs: 2_000, allowIncomplete: true })
		expect(screen.text).toContain('OpenCode Zen / Black')
		await session.keyboard.press('Escape')
		await session.screen.waitForText('SESSIONS · NEWEST FIRST', { timeoutMs: 10_000 })
	}, 30_000)
})
