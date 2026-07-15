/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup } from 'solid-js'

import { theme } from './ThemeState'

export type ActivityState = 'ready' | 'running' | 'compacting' | 'stopped' | 'error'

const presentation = (state: ActivityState, frame: number): { readonly glyph: string; readonly color: string } => {
	switch (state) {
		case 'ready':
			return { glyph: '◆', color: theme.color.grid }
		case 'running':
			return {
				glyph: ['◐', '◓', '◑', '◒'][frame % 4]!,
				color: frame % 2 === 0 ? theme.color.coreBright : theme.color.core,
			}
		case 'compacting':
			return {
				glyph: frame % 2 === 0 ? '◇' : '◆',
				color: frame % 2 === 0 ? theme.color.inject : theme.color.coreBright,
			}
		case 'stopped':
			return { glyph: '■', color: theme.color.textDim }
		case 'error':
			return { glyph: '✕', color: theme.color.alert }
	}
}

export const ActivityIndicator = (props: {
	readonly state: ActivityState
	readonly label?: string
	readonly width?: number
}) => {
	const [frame, setFrame] = createSignal(0)
	const timer = setInterval(() => {
		if (props.state === 'running' || props.state === 'compacting') setFrame((current) => current + 1)
	}, 180)
	onCleanup(() => clearInterval(timer))

	return (
		<text
			fg={presentation(props.state, frame()).color}
			{...(props.width === undefined ? {} : { width: props.width })}
			wrapMode="none"
		>
			{`${presentation(props.state, frame()).glyph} ${props.label ?? props.state.toUpperCase()}`}
		</text>
	)
}
