import { TerminalControl } from '@kitlangton/terminal-control'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let terminal: TerminalControl
const terminalDescribe = process.env.TART_TUI_TERMINAL_TEST === '1' ? describe.sequential : describe.skip

terminalDescribe('TUI manual compaction', () => {
	beforeAll(async () => {
		terminal = await TerminalControl.make()
	})

	afterAll(async () => {
		await terminal.close()
	})

	it('handles /compact locally and inspects its prompt and summary', async () => {
		await using session = await terminal.launch({
			command: ['bun', '--preload', '@opentui/solid/preload', 'test/fixtures/TuiCompactionFixture.tsx'],
			cwd: import.meta.dirname.replace(/\/test$/, ''),
			host: 'opentui',
			viewport: { cols: 150, rows: 48 },
			record: 'on-failure',
		})

		await session.screen.waitForText('Build the compaction view', { timeoutMs: 10_000 })
		await session.screen.waitForText('EVENTS · [SELECTED]', { timeoutMs: 10_000 })
		await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('EVENTS · [FOCUSED]', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('MESSAGE ROOT', { timeoutMs: 10_000 })
		await session.keyboard.type('/compact')
		await session.keyboard.press('Enter')
		await session.screen.waitForText('COMPACTING CONTEXT', { timeoutMs: 10_000 })
		await session.screen.waitForText('SUMMARIZING CONVERSATION', { timeoutMs: 10_000 })
		const compacting = await session.screen.capture({ settleMs: 0, deadlineMs: 250, allowIncomplete: true })
		expect(compacting.text).toContain('SUMMARIZING CONVERSATION')
		expect(compacting.text).not.toContain('ENTER SEND')
		expect(compacting.text).not.toContain('COMPACTENTER')
		await session.screen.waitForText('Ready after compaction', { timeoutMs: 10_000 })
		const completed = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(completed.text).not.toContain('AGENT RECEIVED')

		await session.keyboard.press('Escape')
		await session.screen.waitForText('ENTER TO FOCUS', { timeoutMs: 10_000 })
		await session.keyboard.type('k')
		await session.screen.waitForText('CONTEXT · [INSPECT]', { timeoutMs: 10_000 })
		await session.screen.waitForText('PROMPT', { timeoutMs: 10_000 })
		await session.screen.waitForText('Create a structured context checkpoint summary', { timeoutMs: 10_000 })
		await session.screen.waitForText('SUMMARY', { timeoutMs: 10_000 })
		await session.screen.waitForText('Preserve the compaction context', { timeoutMs: 10_000 })
		await session.screen.waitForText('POST-COMPACTION INSTRUCTIONS', { timeoutMs: 10_000 })
	}, 60_000)
})
