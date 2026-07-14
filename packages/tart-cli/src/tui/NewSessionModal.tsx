/** @jsxImportSource @opentui/solid */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'

import type { ModelConfiguration, ProfileModeName } from '@humanlayer/tart-agent'
import { TextAttributes, type KeyEvent, type TextareaRenderable } from '@opentui/core'
import { registerManagedTextareaLayer } from '@opentui/keymap/addons/opentui'
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid'
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor } from 'solid-js'

import { ModelSelectionModal } from './ModelSelectionModal'
import { theme } from './ThemeState'
import { prepareTuiKeyboard } from './TuiKeymap'

export type NewSessionRequest = { readonly cwd: string } & (
	| { readonly _tag: 'profile'; readonly profile: string }
	| { readonly _tag: 'direct'; readonly provider: string; readonly model: string; readonly mode: ProfileModeName }
)

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
			.sort((left, right) => left.name.localeCompare(right.name))
			.slice(0, 8)
			.map((entry) => join(parent, entry.name))
	} catch {
		return []
	}
}

const DirectorySelectionModal = (props: {
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
	const move = (offset: number): void => {
		setSuggestionFocused(true)
		setSelected((current) => Math.max(0, Math.min(suggestions().length - 1, current + offset)))
	}
	const complete = (): void => {
		const suggestion = suggestions()[selected()]
		if (suggestion === undefined) return
		const completed = `${suggestion}/`
		setValue(completed)
		setSuggestionFocused(false)
		setSelected(0)
		editor?.setText(completed)
		editor?.focus()
	}
	const submit = (): void => {
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
		editor?.blur()
		props.onSubmit(candidate)
	}

	prepareTuiKeyboard(renderer)
	const keymap = createDefaultOpenTuiKeymap(renderer)
	const removeInputKeymap = registerManagedTextareaLayer(keymap, renderer, {
		enabled: () => renderer.currentFocusedEditor === editor,
		bindings: [
			{ key: 'return', cmd: 'input.submit' },
			{ key: 'up', cmd: () => move(-1) },
			{ key: 'down', cmd: () => move(1) },
			{ key: 'tab', cmd: complete },
			{ key: 'escape', cmd: props.onClose },
		],
	})
	onCleanup(removeInputKeymap)
	onMount(() => {
		editor?.focus()
		if (editor !== undefined) editor.cursorOffset = value().length
	})
	useKeyboard((key: KeyEvent) => {
		if (key.eventType === 'release' || renderer.currentFocusedEditor === editor) return
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
			<text height={1} flexShrink={0} fg={theme.color.coreBright} attributes={TextAttributes.BOLD}>
				NEW SESSION
			</text>
			<text height={1} flexShrink={0} fg={theme.color.textDim}>
				Working directory
			</text>
			<textarea
				ref={(input: TextareaRenderable) => (editor = input)}
				focused
				initialValue={value()}
				onContentChange={() => {
					setValue(editor?.plainText ?? '')
					setSelected(0)
					setSuggestionFocused(false)
					setError(null)
				}}
				onSubmit={submit}
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
					<text fg={selected() === index() ? theme.color.coreBright : theme.color.textDim}>
						{`${selected() === index() ? '▸ ' : '  '}${path}/`}
					</text>
				)}
			</For>
			<box flexGrow={1} />
			<text height={1} flexShrink={0} fg={error() === null ? theme.color.textDim : theme.color.alert}>
				{error() ?? '↑↓ select · Tab complete · ⏎ continue · ⎋ cancel'}
			</text>
		</box>
	)
}

export const NewSessionModal = (props: {
	readonly cwd: string
	readonly configuration: ModelConfiguration
	readonly onSubmit: (request: NewSessionRequest) => void
	readonly onClose: () => void
}) => {
	const [selectedCwd, setSelectedCwd] = createSignal<string | null>(null)
	return (
		<Show
			when={selectedCwd()}
			fallback={<DirectorySelectionModal cwd={props.cwd} onSubmit={setSelectedCwd} onClose={props.onClose} />}
		>
			{(cwd: Accessor<string>) => (
				<ModelSelectionModal
					configuration={props.configuration}
					context="new-session"
					title={`NEW SESSION · ${cwd()}`}
					onClose={() => setSelectedCwd(null)}
					onSubmit={(selection) => {
						if (selection._tag === 'profile') {
							props.onSubmit({ _tag: 'profile', profile: selection.profile, cwd: cwd() })
						} else if (selection.mode !== undefined) {
							props.onSubmit({
								_tag: 'direct',
								provider: selection.provider,
								model: selection.model,
								mode: selection.mode,
								cwd: cwd(),
							})
						}
					}}
				/>
			)}
		</Show>
	)
}
