/** @jsxImportSource @opentui/solid */
import type { ModelConfiguration } from '@humanlayer/fold-agent'
import { TextAttributes, type KeyEvent, type ScrollBoxRenderable } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/solid'
import { createEffect, createMemo, createSignal, For } from 'solid-js'

import {
	advanceModelPicker,
	initialModelPickerState,
	modelPickerChoices,
	retreatModelPicker,
	type ModelPickerState,
	type ModelSelectionContext,
	type ModelSelectionRequest,
} from './ModelSelectionState'
import { theme } from './ThemeState'
import { tuiScrollbarOptions } from './TuiChrome'

export type { ModelSelectionRequest } from './ModelSelectionState'

const heading = (state: ModelPickerState): string => {
	switch (state._tag) {
		case 'kind':
			return 'Selection type'
		case 'profile':
			return 'Profile'
		case 'provider':
			return 'Provider'
		case 'model':
			return `Model · ${state.provider}`
		case 'mode':
			return 'Mode'
	}
}

const isRequest = (value: ModelPickerState | ModelSelectionRequest): value is ModelSelectionRequest =>
	'profile' in value || ('model' in value && value._tag === 'direct')

export const ModelSelectionModal = (props: {
	readonly configuration: ModelConfiguration
	readonly context: ModelSelectionContext
	readonly onSubmit: (selection: ModelSelectionRequest) => void
	readonly onClose: () => void
	readonly title?: string
}) => {
	const dimensions = useTerminalDimensions()
	const [state, setState] = createSignal<ModelPickerState>(initialModelPickerState())
	const [selected, setSelected] = createSignal(0)
	const choices = createMemo(() => modelPickerChoices(props.configuration, state()))
	let scroller: ScrollBoxRenderable | undefined
	createEffect(() => scroller?.scrollChildIntoView(`model-choice:${selected()}`))
	const changeState = (next: ModelPickerState) => {
		setState(next)
		setSelected(0)
	}
	const move = (offset: number) =>
		setSelected((current) => Math.max(0, Math.min(choices().length - 1, current + offset)))
	useKeyboard((key: KeyEvent) => {
		if (key.eventType === 'release') return
		if (key.name === 'escape') {
			const previous = retreatModelPicker(state())
			if (previous === null) props.onClose()
			else changeState(previous)
		} else if (key.name === 'up' || key.name === 'k') move(-1)
		else if (key.name === 'down' || key.name === 'j') move(1)
		else if (key.name === 'enter' || key.name === 'return') {
			const choice = choices()[selected()]
			if (choice !== undefined) {
				const next = advanceModelPicker(state(), choice.id, props.context)
				if (isRequest(next)) props.onSubmit(next)
				else changeState(next)
			}
		} else return
		key.preventDefault()
	})
	const width = createMemo(() => Math.min(86, dimensions().width - 4))
	return (
		<box
			position="absolute"
			top={3}
			left={Math.max(2, Math.floor((dimensions().width - width()) / 2))}
			width={width()}
			height={Math.min(24, dimensions().height - 6)}
			zIndex={70}
			flexDirection="column"
			border
			borderStyle="double"
			borderColor={theme.color.coreBright}
			backgroundColor={theme.color.raised}
			padding={1}
		>
			<text height={1} flexShrink={0} fg={theme.color.coreBright} attributes={TextAttributes.BOLD}>
				{props.title ?? 'MODEL SELECTION'}
			</text>
			<text height={1} flexShrink={0} fg={theme.color.textDim}>
				{heading(state())}
			</text>
			<box height={1} />
			<scrollbox
				ref={(value: ScrollBoxRenderable) => (scroller = value)}
				flexGrow={1}
				scrollY
				scrollbarOptions={tuiScrollbarOptions()}
			>
				<For each={choices()}>
					{(choice, index) => (
						<box
							id={`model-choice:${index()}`}
							flexDirection="row"
							backgroundColor={selected() === index() ? theme.color.panel : theme.color.raised}
						>
							<text fg={selected() === index() ? theme.color.coreBright : theme.color.text} flexGrow={1}>
								{`${selected() === index() ? '▸ ' : '  '}${choice.label}`}
							</text>
							<text fg={theme.color.textDim}>{choice.detail}</text>
						</box>
					)}
				</For>
			</scrollbox>
			<text height={1} flexShrink={0} fg={choices().length === 0 ? theme.color.alert : theme.color.textDim}>
				{choices().length === 0
					? 'Nothing configured. Escape, then open Providers / Auth to initialize.'
					: '↑↓/JK select · ⏎ continue · ⎋ back'}
			</text>
		</box>
	)
}
