import { describe, expect, it } from 'vitest'

import { diffForTool, skillMarkdown } from '../src/tui/ToolInspect'

describe('TUI tool inspection', () => {
	it('builds an added-file diff for write', () => {
		const diff = diffForTool('write', JSON.stringify({ path: 'src/new.ts', content: 'const value = 1\n' }))
		expect(diff).toContain('+++ b/src/new.ts')
		expect(diff).toContain('+const value = 1')
	})

	it('builds replacement hunks for edit', () => {
		const diff = diffForTool(
			'edit',
			JSON.stringify({ path: 'src/app.ts', edits: [{ oldText: 'const old = 1', newText: 'const next = 2' }] }),
		)
		expect(diff).toContain('-const old = 1')
		expect(diff).toContain('+const next = 2')
	})

	it('converts a V4A patch to a unified diff', () => {
		const diff = diffForTool(
			'apply_patch',
			JSON.stringify({
				patch_text: [
					'*** Begin Patch',
					'*** Update File: src/app.ts',
					'@@',
					'-const old = 1',
					'+const next = 2',
					'*** End Patch',
				].join('\n'),
			}),
		)
		expect(diff).toContain('--- a/src/app.ts')
		expect(diff).toContain('+const next = 2')
	})

	it('extracts Markdown from a loaded skill wrapper', () => {
		const markdown = skillMarkdown(
			[
				'<skill name="demo" baseDir="/tmp/demo">',
				'Relative paths referenced by this skill (references/, scripts/, ...) resolve against /tmp/demo.',
				'',
				'# Demo',
				'',
				'Run the **checks**.',
				'</skill>',
			].join('\n'),
		)
		expect(markdown).toBe('# Demo\n\nRun the **checks**.')
	})
})
