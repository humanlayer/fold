import { tactical } from '@humanlayer/fold-tui-theme/tactical'
import { describe, expect, it } from 'vitest'

import { containsMarkdown } from '../src/tui/MarkdownDetection'
import { markdownStyleDefinitions, markdownTableOptions } from '../src/tui/MarkdownStyle'

describe('TUI markdown theme', () => {
	it('styles emphasis, links, code, and syntax with TACTICAL tokens', () => {
		const styles = markdownStyleDefinitions('normal')

		expect(styles['markup.strong']).toMatchObject({ bold: true })
		expect(styles['markup.italic']).toMatchObject({ italic: true })
		expect(styles['markup.link']).toMatchObject({ underline: true })
		expect(styles['markup.list']).toEqual({ fg: tactical.color.core })
		expect(styles['markup.raw.block']).toHaveProperty('bg')
		expect(styles.keyword).toMatchObject({ bold: true })
	})

	it('dims reasoning markdown and configures full-width code-friendly tables', () => {
		expect(markdownStyleDefinitions('muted').default).toMatchObject({ dim: true })
		expect(markdownTableOptions).toMatchObject({
			style: 'grid',
			widthMode: 'full',
			columnFitter: 'balanced',
			wrapMode: 'word',
		})
	})

	it('keeps plain streaming prose on the lightweight text path', () => {
		expect(containsMarkdown('Ordinary assistant prose arriving token by token.')).toBe(false)
		expect(containsMarkdown('Use **bold**, _italics_, and `inline code`.')).toBe(true)
		expect(containsMarkdown('```ts\nconst answer = 42\n```')).toBe(true)
	})
})
