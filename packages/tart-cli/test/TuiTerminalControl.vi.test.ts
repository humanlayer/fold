import { TerminalControl } from '@kitlangton/terminal-control'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let terminal: TerminalControl
const terminalDescribe = process.env.TART_TUI_TERMINAL_TEST === '1' ? describe.sequential : describe.skip
const shiftEnter = new TextEncoder().encode('\u001b[13;2u')

terminalDescribe('TUI terminal behavior', () => {
	beforeAll(async () => {
		terminal = await TerminalControl.make()
	})

	afterAll(async () => {
		await terminal.close()
	})

	it('renders markdown in user, reasoning, and assistant rows', async () => {
		await using session = await terminal.launch({
			command: ['bun', '--preload', '@opentui/solid/preload', 'test/fixtures/TuiMarkdownFixture.tsx'],
			cwd: import.meta.dirname.replace(/\/test$/, ''),
			host: 'opentui',
			viewport: { cols: 140, rows: 44 },
			record: 'on-failure',
		})

		await session.screen.waitForText('OPTIC FEED // NOMINAL', { timeoutMs: 10_000 })
		await session.screen.waitForText('themed first item', { timeoutMs: 10_000 })
		const frame = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(frame.text).toContain('User asks for bold input and code')
		expect(frame.text).toContain('const userPrompt = true')
		expect(frame.text).toContain('Thinking with emphasis before answering')
		expect(frame.text).toContain('inlineCode()')
		expect(frame.text).toContain('themed first item')
		const bashLine = frame.text.split('\n').find((line) => line.includes('BASH'))
		expect(bashLine).toContain('⚙')
		expect(bashLine).not.toContain('◆')
		expect(frame.text).not.toContain('**')
		expect(frame.text).not.toContain('```')
		const lines = frame.text.split('\n')
		const firstParagraph = lines.findIndex((line) => line.includes('Assistant returns bold response'))
		const secondParagraph = lines.findIndex((line) => line.includes('Second paragraph after a blank line'))
		expect(secondParagraph - firstParagraph).toBeGreaterThanOrEqual(2)
		await session.keyboard.type('g')
		await session.screen.waitForText('G GLITCH:OFF', { timeoutMs: 10_000 })

		await session.keyboard.press('Enter')
		await session.screen.waitForText('EVENTS · [FOCUSED]', { timeoutMs: 10_000 })
		await session.keyboard.type('k')
		await session.screen.waitForText('ARGUMENTS', { timeoutMs: 10_000 })
		const inspectedTool = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(inspectedTool.text).toContain('CONTEXT · [INSPECT]')
		expect(inspectedTool.text).toContain('COMMAND')
		expect(inspectedTool.text).toContain('pwd')
		expect(inspectedTool.text).toContain('RESULT')
		expect(inspectedTool.text).toContain('/workspace/tart')

		await session.keyboard.press('Escape')
		await session.screen.waitForText('EVENTS · [SELECTED]', { timeoutMs: 10_000 })
		await session.keyboard.type('l')
		await session.screen.waitForText('CONTEXT · [INSPECT] · 2 ⚙ bash · [SELECTED]', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('CONTEXT · [INSPECT] · 2 ⚙ bash · [FOCUSED]', { timeoutMs: 10_000 })

		await session.keyboard.press('Escape')
		await session.screen.waitForText('CONTEXT · [INSPECT] · 2 ⚙ bash · [SELECTED]', { timeoutMs: 10_000 })
		await session.keyboard.type('h')
		await session.screen.waitForText('EVENTS · [SELECTED]', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('EVENTS · [FOCUSED]', { timeoutMs: 10_000 })
		await session.keyboard.press('Tab')
		await session.screen.waitForText('MESSAGE ROOT', { timeoutMs: 10_000 })
		await session.keyboard.type('follow live again')
		await session.keyboard.press('Enter')
		await session.screen.waitForText('CONTEXT · [LIVE] · root', { timeoutMs: 10_000 })
	}, 60_000)

	it('distinguishes partial assistant output and interrupted tools', async () => {
		await using session = await terminal.launch({
			command: ['bun', '--preload', '@opentui/solid/preload', 'test/fixtures/TuiInterruptedFixture.tsx'],
			cwd: import.meta.dirname.replace(/\/test$/, ''),
			host: 'opentui',
			viewport: { cols: 140, rows: 44 },
			record: 'on-failure',
		})

		await session.screen.waitForText('This response stopped midway', { timeoutMs: 10_000 })
		const frame = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(frame.text).toContain('partial')
		expect(frame.text).toContain('⊘ bash')
		expect(frame.text).toContain('intr')
		expect(frame.text).not.toContain('bash  sleep 10  run')
	}, 30_000)

	it('renders the tactical shell, converses from the root input, and exits cleanly', async () => {
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
		expect(initial.text).toContain('V VIGNETTE:LIGHT')
		expect(initial.text).toContain('SEND')
		expect(initial.text).toContain('EVENTS · [SELECTED]')
		expect(initial.text).toContain('TAB TO FOCUS')
		expect(initial.text).toContain('^N NEW')
		expect(initial.text).toContain('ESC SESSIONS')

		await session.keyboard.press('Control+N')
		await session.screen.waitForText('new-session-requested', { timeoutMs: 10_000 })
		await session.keyboard.press('Escape')
		await session.screen.waitForText('session-list-requested', { timeoutMs: 10_000 })

		await session.keyboard.press('Tab')
		await session.screen.waitForText('MESSAGE ROOT', { timeoutMs: 10_000 })
		await session.keyboard.type('b')
		const focusedHotkey = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		const focusedInputLine = focusedHotkey.text.split('\n').find((line) => line.includes('[SEND]'))
		expect(focusedInputLine).toContain('b')
		expect(focusedHotkey.text).toContain('B GLOW:ON')
		await session.keyboard.type('uild slice')
		await session.keyboard.write(shiftEnter)
		const afterShiftEnter = await session.screen.capture({
			settleMs: 100,
			deadlineMs: 5_000,
			allowIncomplete: true,
		})
		expect(afterShiftEnter.text).not.toContain('RECEIVED')
		await session.keyboard.type('two')
		await session.screen.waitForText('two', { timeoutMs: 10_000 })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('SEND RECEIVED', { timeoutMs: 10_000 })
		await session.screen.waitForText('[STEER]', { timeoutMs: 10_000 })
		const steering = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(steering.text).toContain('[STEER]')

		await session.keyboard.type('guide the running turn')
		await session.keyboard.press('Enter')
		await session.screen.waitForText('STEER RECEIVED', { timeoutMs: 10_000 })
		await session.keyboard.press('Tab')
		await session.screen.waitForText('INTERRUPT+SEND', { timeoutMs: 10_000 })
		await session.keyboard.press('Escape')
		await session.screen.waitForText('TAB TO FOCUS', { timeoutMs: 10_000 })
		await session.keyboard.press('Escape')
		await session.screen.waitForText('EVENTS · [SELECTED]', { timeoutMs: 10_000 })

		await session.keyboard.type('b')
		await session.screen.waitForText('B GLOW:OFF', { timeoutMs: 10_000 })
		await session.keyboard.type('g')
		await session.screen.waitForText('G GLITCH:OFF', { timeoutMs: 10_000 })
		await session.keyboard.type('v')
		await session.screen.waitForText('V VIGNETTE:HEAVY', { timeoutMs: 10_000 })
		await session.keyboard.type('v')
		await session.screen.waitForText('V VIGNETTE:OFF', { timeoutMs: 10_000 })
		await session.keyboard.type('v')
		await session.screen.waitForText('V VIGNETTE:LIGHT', { timeoutMs: 10_000 })

		await session.keyboard.type('q')
		const exit = await session.waitForExit({ timeoutMs: 5_000 })
		expect(exit).toMatchObject({ reason: 'exited', exit: { code: 0 } })

		await using interrupted = await terminal.launch({
			command: ['bun', '--preload', '@opentui/solid/preload', 'test/fixtures/TuiAppFixture.tsx'],
			cwd: import.meta.dirname.replace(/\/test$/, ''),
			host: 'opentui',
			viewport: { cols: 140, rows: 44 },
		})
		await interrupted.screen.waitForText('WAITING FOR ROOT-AGENT OUTPUT', { timeoutMs: 10_000 })
		await interrupted.keyboard.press('Control+C')
		await interrupted.screen.waitForText('INTERRUPT REQUESTED', { timeoutMs: 10_000 })
		await interrupted.screen.waitForText('STOPPED', { timeoutMs: 10_000 })
		await interrupted.keyboard.type('b')
		await interrupted.screen.waitForText('B GLOW:OFF', { timeoutMs: 10_000 })
		await interrupted.keyboard.type('q')
		const interruptedExit = await interrupted.waitForExit({ timeoutMs: 5_000 })
		expect(interruptedExit).toMatchObject({ reason: 'exited', exit: { code: 0 } })
	}, 120_000)
})
