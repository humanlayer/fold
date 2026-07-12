/** @jsxImportSource @opentui/solid */
import { TextAttributes, type KeyEvent, type TextareaRenderable } from '@opentui/core'
import { registerManagedTextareaLayer } from '@opentui/keymap/addons/opentui'
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid'
import { createMemo, createSignal, For, onCleanup, onMount } from 'solid-js'

import { theme } from './ThemeState'

export type TuiCommand = {
	readonly id: string
	readonly title: string
	readonly category: 'NAVIGATE' | 'SESSION' | 'VIEW' | 'APPLICATION'
	readonly shortcut?: string
	readonly run?: () => void
	readonly children?: ReadonlyArray<TuiCommand>
}

export const CommandPalette = (props: {
	readonly commands: ReadonlyArray<TuiCommand>
	readonly onClose: () => void
}) => {
	const dimensions = useTerminalDimensions()
	const renderer = useRenderer()
	const [query, setQuery] = createSignal('')
	const [selected, setSelected] = createSignal(0)
	const [page, setPage] = createSignal<ReadonlyArray<TuiCommand> | null>(null)
	let editor: TextareaRenderable | undefined
	const keymap = createDefaultOpenTuiKeymap(renderer)
	const matches = createMemo(() => {
		const value = query().trim().toLowerCase()
		const commands = page() ?? props.commands
		if (value.length === 0) return commands
		const titleMatches = commands.filter((command) => command.title.toLowerCase().includes(value))
		const titleIds = new Set(titleMatches.map((command) => command.id))
		const categoryMatches = commands.filter(
			(command) => !titleIds.has(command.id) && command.category.toLowerCase().includes(value),
		)
		return [...titleMatches, ...categoryMatches]
	})
	const move = (offset: number) =>
		setSelected((current) => Math.max(0, Math.min(matches().length - 1, current + offset)))
	const choose = () => {
		const command = matches()[selected()]
		if (command === undefined) return
		if (command.children !== undefined) {
			setPage(command.children)
			setQuery('')
			setSelected(0)
			editor?.setText('')
			editor?.focus()
			return
		}
		props.onClose()
		command.run?.()
	}
	const back = () => {
		if (page() === null) props.onClose()
		else {
			setPage(null)
			setQuery('')
			setSelected(0)
			editor?.setText('')
			editor?.focus()
		}
	}
	const removeInputKeymap = registerManagedTextareaLayer(keymap, renderer, {
		enabled: () => renderer.currentFocusedEditor === editor,
		bindings: [
			{ key: 'up', cmd: () => move(-1) },
			{ key: 'down', cmd: () => move(1) },
			{ key: 'return', cmd: choose },
			{ key: 'escape', cmd: back },
		],
	})
	onCleanup(removeInputKeymap)
	onMount(() => editor?.focus())
	useKeyboard((key: KeyEvent) => {
		if (key.eventType === 'release') return
		if (key.name === 'escape') {
			key.preventDefault()
			back()
		} else if (key.name === 'up') {
			key.preventDefault()
			move(-1)
		} else if (key.name === 'down') {
			key.preventDefault()
			move(1)
		} else if (key.name === 'enter' || key.name === 'return') {
			key.preventDefault()
			choose()
		}
	})
	const width = createMemo(() => Math.min(76, dimensions().width - 4))
	return (
		<box
			position="absolute"
			top={3}
			left={Math.max(2, Math.floor((dimensions().width - width()) / 2))}
			width={width()}
			height={Math.min(22, dimensions().height - 6)}
			zIndex={50}
			flexDirection="column"
			border
			borderStyle="double"
			borderColor={theme.color.coreBright}
			backgroundColor={theme.color.raised}
			padding={1}
		>
			<box flexDirection="row" height={1}>
				<text fg={theme.color.coreBright} attributes={TextAttributes.BOLD}>
					⌘K ›{' '}
				</text>
				<textarea
					ref={(value: TextareaRenderable) => (editor = value)}
					initialValue={query()}
					onContentChange={() => {
						setQuery(editor?.plainText ?? '')
						setSelected(0)
					}}
					flexGrow={1}
					height={1}
					backgroundColor={theme.color.panel}
					focusedBackgroundColor={theme.color.panel}
					textColor={theme.color.text}
				/>
			</box>
			<box height={1} />
			<box flexDirection="column" flexGrow={1}>
				<For each={matches()}>
					{(command, index) => (
						<box
							flexDirection="row"
							backgroundColor={selected() === index() ? theme.color.panel : theme.color.raised}
						>
							<text fg={theme.color.textDim} width={14}>
								{command.category}
							</text>
							<text fg={selected() === index() ? theme.color.coreBright : theme.color.text} flexGrow={1}>
								{`${selected() === index() ? '▸ ' : '  '}${command.title}`}
							</text>
							<text fg={theme.color.grid}>{command.shortcut ?? ''}</text>
						</box>
					)}
				</For>
			</box>
			<text fg={theme.color.textDim}>↑↓ select · ⏎ run · ⎋ close</text>
		</box>
	)
}
