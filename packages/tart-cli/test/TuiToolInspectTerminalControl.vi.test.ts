import { TerminalControl } from '@kitlangton/terminal-control'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let terminal: TerminalControl
const terminalDescribe = process.env.TART_TUI_TERMINAL_TEST === '1' ? describe.sequential : describe.skip

terminalDescribe('TUI tool inspectors', () => {
	beforeAll(async () => {
		terminal = await TerminalControl.make()
	})

	afterAll(async () => {
		await terminal.close()
	})

	it('renders full read, mutation diffs, and loaded skill Markdown', async () => {
		await using session = await terminal.launch({
			command: ['bun', '--preload', '@opentui/solid/preload', 'test/fixtures/TuiToolInspectFixture.tsx'],
			cwd: import.meta.dirname.replace(/\/test$/, ''),
			host: 'opentui',
			viewport: { cols: 160, rows: 50 },
			record: 'on-failure',
		})

		await session.screen.waitForText('Trailing assistant row keeps skill inspectable', { timeoutMs: 10_000 })
		await session.screen.waitForText('EVENTS · [SELECTED]', { timeoutMs: 10_000 })
		await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		await session.keyboard.press('Enter')
		await session.screen.waitForText('EVENTS · [FOCUSED]', { timeoutMs: 10_000 })

		await session.keyboard.type('k')
		await session.screen.waitForText('SKILL.MD', { timeoutMs: 10_000 })
		await session.screen.waitForText('Loaded Skill Heading', { timeoutMs: 10_000 })
		const skill = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(skill.text).toContain('Use structured verification for this task.')
		expect(skill.text).toContain('<skill name="demo-skill"')
		expect(skill.text).toContain('Relative paths referenced by this skill')
		expect(skill.text).toContain('</skill>')
		expect(skill.text).not.toContain('**structured verification**')

		await session.keyboard.type('gg')
		await session.screen.waitForText('FILE CONTENT', { timeoutMs: 10_000 })
		await session.screen.waitForText('export const fullReadLine = true', { timeoutMs: 10_000 })
		const read = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(read.text).toContain('FILE CONTENT')

		await session.keyboard.type('j')
		await session.screen.waitForText('createdValue', { timeoutMs: 10_000 })
		const write = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(write.text).toContain('DIFF')
		await session.keyboard.type('j')
		await session.screen.waitForText('newValue', { timeoutMs: 10_000 })
		const edit = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(edit.text).toContain('const oldValue = 1')
		await session.keyboard.type('j')
		await session.screen.waitForText('afterPatch', { timeoutMs: 10_000 })
		const patch = await session.screen.capture({ settleMs: 100, deadlineMs: 5_000, allowIncomplete: true })
		expect(patch.text).toContain('const beforePatch = 1')
	}, 60_000)
})
