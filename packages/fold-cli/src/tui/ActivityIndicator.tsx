/** @jsxImportSource @opentui/solid */
import type { TextProps } from '@opentui/solid'
import { createMemo, createSignal, onCleanup } from 'solid-js'

import { theme } from './ThemeState'

export type ActivityState = 'ready' | 'running' | 'compacting' | 'stopped' | 'error'
type Mutable<Type> = { -readonly [Key in keyof Type]: Type[Key] }

const presentation = (state: ActivityState, frame: number): { readonly glyph: string; readonly color: string } => {
	switch (state) {
		case 'ready':
			return { glyph: '◆', color: theme.color.grid }
		case 'running':
			return {
				glyph: ['◐', '◓', '◑', '◒'][frame % 4] ?? '◐',
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

	const value = createMemo(() => presentation(props.state, frame()))
	const textProps = createMemo(() => {
		const text: Mutable<Pick<TextProps, 'fg' | 'width' | 'wrapMode'>> = {
			fg: value().color,
			wrapMode: 'none',
		}
		if (props.width !== undefined) text.width = props.width
		return text
	})

	return <text {...textProps()}>{`${value().glyph} ${props.label ?? props.state.toUpperCase()}`}</text>
}
