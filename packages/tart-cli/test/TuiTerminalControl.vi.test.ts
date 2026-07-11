import { TerminalControl } from '@kitlangton/terminal-control'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let terminal: TerminalControl
const terminalDescribe = process.env.TART_TUI_TERMINAL_TEST === '1' ? describe.sequential : describe.skip

terminalDescribe('TUI terminal behavior', () => {
	beforeAll(async () => {
		terminal = await TerminalControl.make()
	})

	afterAll(async () => {
		await terminal.close()
	})

	it('renders the tactical shell, responds to keys, and exits cleanly', async () => {
		await using session = await terminal.launch({
			command: ['bun', '--preload', '@opentui/solid/preload', 'test/fixtures/TuiAppFixture.tsx'],
			cwd: import.meta.dirname.replace(/\/test$/, ''),
			host: 'opentui',
			viewport: { cols: 140, rows: 44 },
			record: 'on-failure',
		})

		await session.screen.waitForText('WAITING FOR ROOT-AGENT OUTPUT', { timeoutMs: 10_000 })
		const initial = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(initial.text).toContain('OPTIC FEED // NOMINAL')
		expect(initial.text).toContain('REPO// /workspace/tart')
		expect(initial.text).toContain('FX//')
		expect(initial.text).toContain('B GLOW:ON')
		expect(initial.text).toContain('V VIGNETTE:HEAVY')

		await session.keyboard.type('b')
		await session.screen.waitForText('B GLOW:OFF', { timeoutMs: 10_000 })
		await session.keyboard.type('v')
		await session.screen.waitForText('V VIGNETTE:OFF', { timeoutMs: 10_000 })
		await session.keyboard.type('v')
		await session.screen.waitForText('V VIGNETTE:LIGHT', { timeoutMs: 10_000 })
		await session.keyboard.type('v')
		await session.screen.waitForText('V VIGNETTE:HEAVY', { timeoutMs: 10_000 })

		await session.keyboard.type('q')
		const exit = await session.waitForExit({ timeoutMs: 5_000 })
		expect(exit).toMatchObject({ reason: 'exited', exit: { code: 0 } })

		await using interrupted = await terminal.launch({
			command: ['bun', '--preload', '@opentui/solid/preload', 'test/fixtures/TuiAppFixture.tsx'],
			cwd: import.meta.dirname.replace(/\/test$/, ''),
			host: 'opentui',
			viewport: { cols: 100, rows: 30 },
		})
		await interrupted.screen.waitForText('WAITING FOR ROOT-AGENT OUTPUT', { timeoutMs: 10_000 })
		await interrupted.keyboard.press('Control+C')
		const interruptedExit = await interrupted.waitForExit({ timeoutMs: 5_000 })
		expect(interruptedExit).toMatchObject({ reason: 'exited', exit: { code: 0 } })
	}, 60_000)
})
