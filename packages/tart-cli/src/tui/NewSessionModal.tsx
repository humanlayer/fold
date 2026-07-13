import { readdirSync, statSync } from 'node:fs'
/** @jsxImportSource @opentui/solid */
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'

import { TextAttributes, type KeyEvent, type TextareaRenderable } from '@opentui/core'
import { registerManagedTextareaLayer } from '@opentui/keymap/addons/opentui'
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid'
import { createMemo, createSignal, For, onCleanup, onMount } from 'solid-js'

import { theme } from './ThemeState'

const expandHome = (value: string): string =>
	value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value

const directorySuggestions = (value: string, cwd: string): ReadonlyArray<string> => {
	const expanded = expandHome(value.trim())
	const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded || '.')
	const endsWithSlash = expanded.endsWith('/')
	const parent = endsWithSlash ? absolute : dirname(absolute)
	const prefix = endsWithSlash ? '' : absolute.slice(parent.length + (parent === '/' ? 0 : 1)).toLowerCase()
	try {
		return readdirSync(parent, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix))
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, 8)
			.map((entry) => join(parent, entry.name))
	} catch {
		return []
	}
}

export const NewSessionModal = (props: {
	readonly cwd: string
	readonly onSubmit: (cwd: string) => void
	readonly onClose: () => void
}) => {
	const renderer = useRenderer()
	const dimensions = useTerminalDimensions()
	const [value, setValue] = createSignal(props.cwd)
	const [selected, setSelected] = createSignal(0)
	const [suggestionFocused, setSuggestionFocused] = createSignal(false)
	const [error, setError] = createSignal<string | null>(null)
	let editor: TextareaRenderable | undefined
	const suggestions = createMemo(() => directorySuggestions(value(), props.cwd))
	const move = (offset: number) => {
		setSuggestionFocused(true)
		setSelected((current) => Math.max(0, Math.min(suggestions().length - 1, current + offset)))
	}
	const complete = () => {
		const suggestion = suggestions()[selected()]
		if (suggestion === undefined) return
		setValue(`${suggestion}/`)
		setSuggestionFocused(false)
		setSelected(0)
		editor?.setText(`${suggestion}/`)
		editor?.focus()
	}
	const submit = () => {
		const selectedPath = suggestionFocused() ? suggestions()[selected()] : undefined
		const candidate = normalize(
			selectedPath ?? resolve(props.cwd, expandHome((editor?.plainText ?? value()).trim())),
		)
		try {
			if (!statSync(candidate).isDirectory()) throw new Error('not a directory')
		} catch {
			setError('Enter an existing directory')
			return
		}
		props.onSubmit(candidate)
	}
	const keymap = createDefaultOpenTuiKeymap(renderer)
	const removeInputKeymap = registerManagedTextareaLayer(keymap, renderer, {
		enabled: () => renderer.currentFocusedEditor === editor,
		bindings: [
			{ key: 'up', cmd: () => move(-1) },
			{ key: 'down', cmd: () => move(1) },
			{ key: 'tab', cmd: complete },
			{ key: 'return', cmd: submit },
			{ key: 'escape', cmd: props.onClose },
		],
	})
	onCleanup(removeInputKeymap)
	onMount(() => {
		editor?.focus()
		if (editor !== undefined) editor.cursorOffset = value().length
	})
	useKeyboard((key: KeyEvent) => {
		if (key.eventType === 'release') return
		if (key.name === 'escape') props.onClose()
		else if (key.name === 'up') move(-1)
		else if (key.name === 'down') move(1)
		else if (key.name === 'tab') complete()
		else if (key.name === 'enter' || key.name === 'return') submit()
		else return
		key.preventDefault()
	})
	const width = createMemo(() => Math.min(82, dimensions().width - 4))
	return (
		<box
			position="absolute"
			top={4}
			left={Math.max(2, Math.floor((dimensions().width - width()) / 2))}
			width={width()}
			height={15}
			zIndex={60}
			flexDirection="column"
			border
			borderStyle="double"
			borderColor={theme.color.coreBright}
			backgroundColor={theme.color.panel}
			padding={1}
		>
			<text fg={theme.color.coreBright} attributes={TextAttributes.BOLD}>
				NEW SESSION
			</text>
			<text fg={theme.color.textDim}>Working directory</text>
			<textarea
				ref={(input: TextareaRenderable) => (editor = input)}
				initialValue={value()}
				onContentChange={() => {
					setValue(editor?.plainText ?? '')
					setSelected(0)
					setSuggestionFocused(false)
					setError(null)
				}}
				height={1}
				backgroundColor={theme.color.raised}
				focusedBackgroundColor={theme.color.raised}
				textColor={theme.color.coreBright}
				focusedTextColor={theme.color.coreBright}
				cursorColor={theme.color.coreBright}
				cursorStyle={{ style: 'line', blinking: true }}
			/>
			<box height={1} />
			<For each={suggestions()}>
				{(path, index) => (
					<text
						fg={selected() === index() ? theme.color.coreBright : theme.color.textDim}
					>{`${selected() === index() ? '▸ ' : '  '}${path}/`}</text>
				)}
			</For>
			<box flexGrow={1} />
			<text fg={error() === null ? theme.color.textDim : theme.color.alert}>
				{error() ?? '↑↓ select · Tab complete · ⏎ create · ⎋ cancel'}
			</text>
		</box>
	)
}
