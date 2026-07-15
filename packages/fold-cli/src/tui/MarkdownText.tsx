/** @jsxImportSource @opentui/solid */
import { tactical } from '@humanlayer/fold-tui-theme/tactical'
import { TextRenderable, type MarkdownOptions } from '@opentui/core'
import { useRenderer } from '@opentui/solid'

import { markdownSyntaxStyle, markdownTableOptions, markdownTreeSitterClient, type MarkdownTone } from './MarkdownStyle'

export type MarkdownTextProps = {
	readonly content: string
	readonly tone: MarkdownTone
}

export const MarkdownText = (props: MarkdownTextProps) => {
	const renderer = useRenderer()
	const renderNode: NonNullable<MarkdownOptions['renderNode']> = (token) => {
		if (token.type !== 'code') return undefined

		return new TextRenderable(renderer, {
			content: token.text,
			fg: props.tone === 'muted' ? tactical.color.gridDim : tactical.color.grid,
			bg: tactical.color.raised,
			wrapMode: 'none',
			width: '100%',
			flexShrink: 0,
		})
	}

	return (
		<markdown
			syntaxStyle={markdownSyntaxStyle(props.tone)}
			content={props.content}
			fg={props.tone === 'muted' ? tactical.color.textDim : tactical.color.text}
			conceal
			streaming
			internalBlockMode="top-level"
			width="100%"
			flexShrink={0}
			tableOptions={markdownTableOptions}
			treeSitterClient={markdownTreeSitterClient}
			renderNode={renderNode}
		/>
	)
}
