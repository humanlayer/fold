/** @jsxImportSource @opentui/solid */
import { installPostFx, ALL_FX_ON, nextVignetteMode, type FxToggles } from '@humanlayer/tart-tui-theme/postfx'
import { tactical } from '@humanlayer/tart-tui-theme/tactical'
import { TextAttributes, type KeyEvent, type ScrollBoxRenderable, type TextareaRenderable } from '@opentui/core'
import { registerManagedTextareaLayer } from '@opentui/keymap/addons/opentui'
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid'
import { createEffect, createMemo, createSignal, Index, onCleanup, Show, type Accessor } from 'solid-js'

import { nextRootInputVerb, normalizeRootInputVerb, rootInputVerbLabel, type RootInputVerb } from './Converse'
import { containsMarkdown } from './MarkdownDetection'
import { MarkdownText } from './MarkdownText'
import {
	contextMode,
	followLive,
	initialNavigationState,
	jumpSelection,
	moveSelection,
	reconcileSelection,
	type NavigationState,
} from './Navigation'
import { conversationRows, replayIsReady, type ConversationRow, type SessionState } from './SessionState'
import { diffHeight, diffsForTool, skillInspection } from './ToolInspect'
import { TUI_CONTEXT_TITLE, TUI_INSPECT_BADGE, TUI_LIVE_BADGE } from './TuiChrome'

export type TuiAppProps = {
	readonly state: Accessor<SessionState>
	readonly cwd: string
	readonly sessionId: string
	readonly mode: string
	readonly profile: string
	readonly notice: Accessor<string | null>
	readonly compacting?: Accessor<boolean>
	readonly onSubmit: (verb: RootInputVerb, text: string) => void
	readonly onCompact: () => void
	readonly onInterrupt: () => void
	readonly onCopySessionId?: () => void
}

const statusColor = (status: SessionState['status']): string =>
	status === 'RUNNING' ? tactical.color.coreBright : status === 'STOPPED' ? tactical.color.alert : tactical.color.grid

const KeyHint = (props: { readonly keyName: string; readonly label: string }) => (
	<text wrapMode="none">
		<span style={{ fg: tactical.color.coreBright }}>{props.keyName}</span>
		<span style={{ fg: tactical.color.textDim }}>{` ${props.label}`}</span>
	</text>
)

const Toggle = (props: {
	readonly label: string
	readonly name: string
	readonly enabled: boolean
	readonly status?: string
	readonly verbose: boolean
}) => (
	<text wrapMode="none">
		<span style={{ fg: tactical.color.coreBright }}>{props.label}</span>
		{props.verbose ? <span style={{ fg: tactical.color.textDim }}>{` ${props.name}`}</span> : null}
		<span style={{ fg: tactical.color.textDim }}>:</span>
		<span style={{ fg: props.enabled ? tactical.color.grid : tactical.color.textDim }}>
			{props.status ?? (props.enabled ? 'ON' : 'OFF')}
		</span>
	</text>
)

const toolGlyph = (toolName: string | null): string => {
	switch (toolName) {
		case 'read':
			return '▤'
		case 'edit':
			return '✎'
		case 'write':
			return '✚'
		case 'subagent':
			return '★'
		case 'skill':
			return '✦'
		default:
			return '⚙'
	}
}

const toolColor = (toolName: string | null): string => {
	switch (toolName) {
		case 'read':
			return tactical.color.textDim
		case 'subagent':
			return tactical.color.inject
		case 'skill':
			return tactical.semantic.merged
		default:
			return tactical.color.core
	}
}

const rowVisual = (row: ConversationRow): { readonly glyph: string; readonly color: string; readonly dim: boolean } => {
	switch (row.kind) {
		case 'user':
			return { glyph: '›', color: tactical.color.grid, dim: false }
		case 'assistant':
			return { glyph: '◇', color: tactical.color.coreBright, dim: false }
		case 'reasoning':
			return { glyph: '∴', color: tactical.color.textDim, dim: true }
		case 'tool-call':
			return {
				glyph: toolGlyph(row.toolName),
				color: row.status === 'error' ? tactical.color.alert : toolColor(row.toolName),
				dim: false,
			}
		case 'tool-result':
			return {
				glyph: row.isFailure ? '✕' : '⮑',
				color: row.isFailure ? tactical.color.alert : tactical.color.gridDim,
				dim: true,
			}
		case 'compaction':
			return { glyph: '⧗', color: tactical.color.grid, dim: true }
		case 'error':
			return { glyph: '✕', color: tactical.color.alert, dim: false }
	}
}

const EventRow = (props: { readonly row: Accessor<ConversationRow> }) => {
	const visual = createMemo(() => rowVisual(props.row()))
	const isToolCall = createMemo(() => props.row().kind === 'tool-call')
	const bodyColor = createMemo(() =>
		isToolCall() ? tactical.color.textDim : visual().dim ? tactical.color.textDim : tactical.color.text,
	)
	const rendersMarkdown = createMemo(
		() =>
			['user', 'assistant', 'reasoning', 'compaction'].includes(props.row().kind) &&
			containsMarkdown(props.row().text),
	)
	return (
		<box flexDirection="row" flexShrink={0} width="100%" paddingLeft={1} paddingRight={1}>
			<box width={3} flexShrink={0}>
				<text fg={visual().color} wrapMode="none">
					{visual().glyph}
				</text>
			</box>
			<box width={12} flexShrink={0}>
				<text
					fg={visual().color}
					attributes={visual().dim ? TextAttributes.DIM : TextAttributes.NONE}
					wrapMode="none"
				>
					{props.row().label}
				</text>
			</box>
			<box flexGrow={1} flexShrink={1}>
				{rendersMarkdown() ? (
					<MarkdownText content={props.row().text} tone={visual().dim ? 'muted' : 'normal'} />
				) : (
					<text
						fg={bodyColor()}
						attributes={visual().dim ? TextAttributes.DIM : TextAttributes.NONE}
						wrapMode="word"
					>
						{props.row().text}
					</text>
				)}
			</box>
		</box>
	)
}

const DetailSection = (props: { readonly title: string; readonly text: string; readonly muted?: boolean }) => (
	<box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
		<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
			{props.title}
		</text>
		<text fg={props.muted ? tactical.color.textDim : tactical.color.text} wrapMode="word">
			{props.text.length === 0 ? '(empty)' : props.text}
		</text>
	</box>
)

type DetailField = { readonly name: string; readonly value: string }

const detailFields = (text: string): ReadonlyArray<DetailField> => {
	try {
		const value: unknown = JSON.parse(text)
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ name: 'VALUE', value: text }]
		return Object.entries(value).map(([name, field]) => ({
			name: name.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase(),
			value: typeof field === 'string' ? field : (JSON.stringify(field, null, 2) ?? String(field)),
		}))
	} catch {
		return [{ name: 'VALUE', value: text }]
	}
}

const DetailFields = (props: { readonly title: string; readonly text: string }) => {
	const fields = createMemo(() => detailFields(props.text))
	return (
		<box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
			<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
				{props.title}
			</text>
			<Index each={fields()}>
				{(field) => (
					<box flexDirection="row" flexShrink={0} width="100%">
						<text fg={tactical.color.textDim} width={16} flexShrink={0} wrapMode="none">
							{field().name}
						</text>
						<text fg={tactical.color.text} flexGrow={1} flexShrink={1} wrapMode="word">
							{field().value}
						</text>
					</box>
				)}
			</Index>
		</box>
	)
}

const EventDetail = (props: { readonly row: Accessor<ConversationRow> }) => {
	const visual = createMemo(() => rowVisual(props.row()))
	const isToolCall = createMemo(() => props.row().kind === 'tool-call')
	const input = createMemo(() => props.row().inputText)
	const executedInput = createMemo(() => props.row().executedInputText)
	const result = createMemo(() => props.row().resultText)
	const diffs = createMemo(() => diffsForTool(props.row().toolName, executedInput() ?? input()))
	const readContent = createMemo(() => (props.row().toolName === 'read' ? result() : null))
	const loadedSkill = createMemo(() => (props.row().toolName === 'skill' ? skillInspection(result()) : null))

	return props.row().kind === 'compaction' ? (
		<box flexDirection="column" flexShrink={0} width="100%">
			<box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} gap={1}>
				<text fg={visual().color} attributes={TextAttributes.BOLD} wrapMode="none">
					{`${visual().glyph} COMPACTION`}
				</text>
				<box flexGrow={1} />
				<text fg={tactical.color.textDim} wrapMode="none">
					CHECKPOINT
				</text>
			</box>
			<box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
				<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
					PROMPT
				</text>
				<MarkdownText content={props.row().inputText ?? ''} tone="muted" />
			</box>
			<box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
				<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
					SUMMARY
				</text>
				<MarkdownText content={props.row().resultText ?? props.row().text} tone="normal" />
			</box>
			{props.row().executedInputText !== null ? (
				<DetailSection title="POST-COMPACTION INSTRUCTIONS" text={props.row().executedInputText ?? ''} muted />
			) : null}
		</box>
	) : (
		<Show when={isToolCall()} fallback={<EventRow row={props.row} />}>
			<box flexDirection="column" flexShrink={0} width="100%">
				<box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} gap={1}>
					<text fg={visual().color} attributes={TextAttributes.BOLD} wrapMode="none">
						{`${visual().glyph} ${props.row().label}`}
					</text>
					<box flexGrow={1} />
					<text fg={visual().color} wrapMode="none">
						{props.row().status.toUpperCase()}
					</text>
				</box>
				{input() !== null ? <DetailFields title="ARGUMENTS" text={input() ?? ''} /> : null}
				{executedInput() !== null ? (
					<DetailFields title="EXECUTED ARGUMENTS" text={executedInput() ?? ''} />
				) : null}
				{result() !== null && loadedSkill() === null ? (
					<DetailSection title={props.row().isFailure ? 'ERROR RESULT' : 'RESULT'} text={result() ?? ''} />
				) : result() === null ? (
					<DetailSection title="RESULT" text="Tool is still running" muted />
				) : null}
				{readContent() !== null ? <DetailSection title="FILE CONTENT" text={readContent() ?? ''} /> : null}
				{loadedSkill() !== null ? (
					<box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
						<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
							RESULT · SKILL.MD
						</text>
						<text fg={tactical.color.textDim} wrapMode="word">
							{loadedSkill()?.openingTag ?? ''}
						</text>
						{loadedSkill()?.relativePathNote !== null ? (
							<text fg={tactical.color.textDim} wrapMode="word">
								{loadedSkill()?.relativePathNote ?? ''}
							</text>
						) : null}
						<MarkdownText content={loadedSkill()?.markdown ?? ''} tone="normal" />
						<text fg={tactical.color.textDim} wrapMode="word">
							{loadedSkill()?.closingTag ?? ''}
						</text>
						{loadedSkill()?.trailingText !== null ? (
							<text fg={tactical.color.textDim} wrapMode="word">
								{loadedSkill()?.trailingText ?? ''}
							</text>
						) : null}
					</box>
				) : null}
				<Index each={diffs()}>
					{(diff) => (
						<box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
							<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
								DIFF
							</text>
							<diff
								diff={diff()}
								view="unified"
								width="100%"
								height={diffHeight(diff())}
								flexShrink={0}
								wrapMode="word"
								showLineNumbers
								fg={tactical.color.text}
								addedSignColor={tactical.color.grid}
								removedSignColor={tactical.color.alert}
								lineNumberFg={tactical.color.textDim}
							/>
						</box>
					)}
				</Index>
			</box>
		</Show>
	)
}

const EventIndexRow = (props: { readonly row: Accessor<ConversationRow>; readonly selected: Accessor<boolean> }) => {
	const visual = createMemo(() => rowVisual(props.row()))
	const sequence = createMemo(() => (props.row().seq === null ? '···' : String(props.row().seq)).padStart(4, ' '))
	const status = createMemo(() => {
		if (props.row().kind !== 'tool-call') return ''
		if (props.row().status === 'running') return 'run'
		if (props.row().status === 'error') return 'err'
		return 'done'
	})
	const summary = createMemo(() =>
		props
			.row()
			.text.replaceAll('\n', ' ')
			.replace(/(```|`|\*\*|__|[*_>#])/g, '')
			.trim(),
	)
	return (
		<box
			id={`event:${props.row().key}`}
			flexDirection="row"
			width="100%"
			height={1}
			paddingLeft={0}
			paddingRight={0}
			backgroundColor={props.selected() ? tactical.color.raised : tactical.color.panel}
		>
			<box width={18} flexShrink={0}>
				<text wrapMode="none">
					<span style={{ fg: tactical.color.coreBright }}>{props.selected() ? '▸' : ' '}</span>
					<span style={{ fg: tactical.color.textFaint }}>{sequence()}</span>
					<span style={{ fg: visual().color }}>
						{` ${visual().glyph} ${props.row().label.toLowerCase().padEnd(9, ' ')} `}
					</span>
				</text>
			</box>
			<text fg={props.selected() ? tactical.color.text : tactical.color.textDim} flexGrow={1} wrapMode="none">
				{summary()}
			</text>
			<text fg={visual().color} width={5} wrapMode="none">
				{status()}
			</text>
		</box>
	)
}

export const TuiApp = (props: TuiAppProps) => {
	const renderer = useRenderer()
	const dimensions = useTerminalDimensions()
	const [toggles, setToggles] = createSignal<FxToggles>({ ...ALL_FX_ON, vignette: 'light' })
	const [draft, setDraft] = createSignal('')
	const [inputFocused, setInputFocused] = createSignal(false)
	const [verb, setVerb] = createSignal<RootInputVerb>('send')
	const [navigation, setNavigation] = createSignal<NavigationState>(initialNavigationState)
	let editor: TextareaRenderable | undefined
	let eventsScroller: ScrollBoxRenderable | undefined
	let contextScroller: ScrollBoxRenderable | undefined
	let pendingG = false
	const keymap = createDefaultOpenTuiKeymap(renderer)
	const removeInputKeymap = registerManagedTextareaLayer(keymap, renderer, {
		enabled: () => inputFocused() && renderer.currentFocusedEditor === editor,
		bindings: [
			{ key: 'return', cmd: 'input.submit' },
			{ key: 'shift+return', cmd: 'input.newline' },
			{ key: 'ctrl+return', cmd: 'input.newline' },
			{ key: 'alt+return', cmd: 'input.newline' },
			{ key: 'ctrl+j', cmd: 'input.newline' },
		],
	})
	onCleanup(removeInputKeymap)
	const rows = createMemo(() => conversationRows(props.state()))
	const rowKeys = createMemo(() => rows().map((row) => row.key))
	const mode = createMemo(() => contextMode(navigation(), rowKeys()))
	const selectedRow = createMemo(() => {
		const selectedKey = navigation().selectedKey
		return selectedKey === null ? undefined : rows().find((row) => row.key === selectedKey)
	})
	const visibleContextRows = createMemo(() => {
		const selected = selectedRow()
		return mode() === 'inspect' && selected !== undefined ? [selected] : rows()
	})
	const eventPaneWidth = createMemo(() => (dimensions().width < 84 ? '40%' : '32%'))
	const verboseFooter = createMemo(() => dimensions().width >= 120)
	const verbLabel = createMemo(() => rootInputVerbLabel(verb()))
	const isCompacting = createMemo(() => props.compacting?.() === true)
	const paneState = (pane: NavigationState['pane']): 'inactive' | 'selected' | 'focused' => {
		if (navigation().pane !== pane) return 'inactive'
		return navigation().level === 'pane' ? 'selected' : 'focused'
	}
	const paneBorderColor = (pane: NavigationState['pane']): string => {
		const state = paneState(pane)
		return state === 'inactive' ? tactical.chrome.border : tactical.color.coreBright
	}
	const paneTitleColor = (pane: NavigationState['pane']): string =>
		paneState(pane) === 'focused'
			? tactical.color.coreBright
			: paneState(pane) === 'selected'
				? tactical.color.coreBright
				: tactical.color.textDim
	const paneTitle = (pane: NavigationState['pane'], label: string): string => {
		const state = paneState(pane)
		return state === 'focused'
			? ` ◆ ${label} · [FOCUSED] `
			: state === 'selected'
				? ` ▸ ${label} · [SELECTED] `
				: ` ${label} `
	}
	const contextSubject = createMemo(() => {
		const selected = selectedRow()
		if (mode() === 'live' || selected === undefined) return 'root'
		const visual = rowVisual(selected)
		return `${selected.seq ?? 'live'} ${visual.glyph} ${selected.label.toLowerCase()}`
	})
	const submitDraft = (): void => {
		const text = (editor?.plainText ?? draft()).trim()
		if (text.length === 0) return
		if (text === '/compact') props.onCompact()
		else props.onSubmit(verb(), text)
		setNavigation(followLive)
		setDraft('')
		editor?.setText('')
		if (inputFocused()) editor?.focus()
	}

	createEffect(() => setVerb((current) => normalizeRootInputVerb(props.state().status, current)))
	createEffect(() => setNavigation((current) => reconcileSelection(current, rowKeys())))
	createEffect(() => {
		const selectedKey = navigation().selectedKey ?? rows().at(-1)?.key
		if (selectedKey !== undefined) eventsScroller?.scrollChildIntoView(`event:${selectedKey}`)
	})

	createEffect(() => {
		renderer.setBackgroundColor(tactical.color.void)
		const removeFx = installPostFx(renderer, tactical, toggles())
		onCleanup(removeFx)
	})

	useKeyboard((key: KeyEvent) => {
		if (key.eventType === 'release') return
		if (key.ctrl && key.name === 'c') {
			key.preventDefault()
			props.onInterrupt()
			return
		}

		if (inputFocused()) {
			if (key.name === 'escape') {
				key.preventDefault()
				setInputFocused(false)
				setNavigation((current) => ({ ...current, pane: 'events', level: 'content' }))
				return
			}
			if (key.name === 'tab') {
				key.preventDefault()
				setVerb((current) => nextRootInputVerb(props.state().status, current))
				return
			}
			return
		}

		if (navigation().level === 'content') {
			if (key.name === 'escape') {
				key.preventDefault()
				setNavigation((current) => ({ ...current, level: 'pane' }))
				return
			}
			if (key.name === 'tab' && navigation().pane === 'events') {
				key.preventDefault()
				setInputFocused(true)
				setNavigation((current) => ({ ...current, level: 'input' }))
				return
			}
			if (navigation().pane === 'events') {
				if (key.name === 'j' || key.name === 'down') {
					key.preventDefault()
					setNavigation((current) => moveSelection(current, rowKeys(), 1))
					return
				}
				if (key.name === 'k' || key.name === 'up') {
					key.preventDefault()
					setNavigation((current) => moveSelection(current, rowKeys(), -1))
					return
				}
				if (key.name === 'G' || (key.name === 'g' && key.shift)) {
					key.preventDefault()
					setNavigation((current) => jumpSelection(current, rowKeys(), 'last'))
					return
				}
				if (key.name === 'g') {
					key.preventDefault()
					if (pendingG) setNavigation((current) => jumpSelection(current, rowKeys(), 'first'))
					pendingG = !pendingG
					return
				}
			} else {
				if (key.name === 'j' || key.name === 'down') {
					key.preventDefault()
					contextScroller?.scrollBy(1, 'step')
					return
				}
				if (key.name === 'k' || key.name === 'up') {
					key.preventDefault()
					contextScroller?.scrollBy(-1, 'step')
					return
				}
				if (key.name === 'G' || (key.name === 'g' && key.shift)) {
					key.preventDefault()
					contextScroller?.scrollTo(contextScroller.scrollHeight)
					return
				}
				if (key.name === 'g') {
					key.preventDefault()
					if (pendingG) contextScroller?.scrollTo(0)
					pendingG = !pendingG
					return
				}
			}
			pendingG = false
			return
		}

		switch (key.name) {
			case 'q':
				renderer.destroy()
				return
			case 'tab':
				if (navigation().pane === 'events') {
					key.preventDefault()
					setInputFocused(true)
					setNavigation((current) => ({ ...current, level: 'input' }))
				}
				return
			case 'enter':
			case 'return':
				key.preventDefault()
				setNavigation((current) => ({ ...current, level: 'content' }))
				return
			case 'h':
			case 'left':
				key.preventDefault()
				setNavigation((current) => ({ ...current, pane: 'events' }))
				return
			case 'l':
			case 'right':
				key.preventDefault()
				setNavigation((current) => ({ ...current, pane: 'context' }))
				return
			case 'b':
				setToggles((current) => ({ ...current, glow: !current.glow }))
				return
			case 's':
				setToggles((current) => ({ ...current, scanlines: !current.scanlines }))
				return
			case 'g':
				setToggles((current) => ({ ...current, glitch: !current.glitch }))
				return
			case 'v':
				setToggles((current) => ({ ...current, vignette: nextVignetteMode(current.vignette) }))
				return
			case 'r':
				setToggles((current) => ({ ...current, rollingBar: !current.rollingBar }))
		}
	})

	return (
		<box flexDirection="column" width="100%" height="100%" backgroundColor={tactical.color.void}>
			<box
				flexDirection="row"
				height={5}
				paddingX={1}
				gap={3}
				alignItems="center"
				border={['bottom']}
				borderStyle={tactical.chrome.frameStyle}
				borderColor={tactical.chrome.border}
			>
				<ascii_font text="TART" font="tiny" color={tactical.color.core} />
				<box flexDirection="column" justifyContent="center">
					<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
						{tactical.name}
					</text>
					<text fg={tactical.color.textDim} wrapMode="none">
						{tactical.tagline}
					</text>
				</box>
				<box flexGrow={1} justifyContent="center">
					<text wrapMode="none">
						<span style={{ fg: tactical.color.textFaint }}>REPO// </span>
						<span style={{ fg: tactical.color.grid }}>{props.cwd}</span>
					</text>
				</box>
				<box flexDirection="column" alignItems="flex-end" justifyContent="center">
					<text wrapMode="none">
						<span style={{ fg: tactical.color.textFaint }}>STATUS </span>
						<span style={{ fg: statusColor(props.state().status) }}>{props.state().status}</span>
					</text>
					<text wrapMode="none">
						<span style={{ fg: tactical.color.textFaint }}>{`${props.mode} · ${props.profile} · `}</span>
						<span style={{ fg: tactical.color.text }}>{props.state().model}</span>
					</text>
				</box>
			</box>

			<box flexGrow={1} flexDirection="row">
				<box
					width={eventPaneWidth()}
					flexDirection="column"
					border
					borderStyle={
						paneState('events') === 'focused'
							? tactical.chrome.frameStyle
							: paneState('events') === 'selected'
								? 'double'
								: tactical.chrome.panelStyle
					}
					borderColor={paneBorderColor('events')}
					title={paneTitle('events', 'EVENTS')}
					titleColor={paneTitleColor('events')}
					backgroundColor={tactical.color.panel}
				>
					<scrollbox
						ref={(renderable) => {
							eventsScroller = renderable
						}}
						flexGrow={1}
						scrollY
					>
						<Index each={rows()} fallback={<text fg={tactical.color.textFaint}> WAITING FOR EVENTS</text>}>
							{(row) => (
								<EventIndexRow
									row={row}
									selected={() =>
										navigation().selectedKey === row().key ||
										(mode() === 'live' && row().key === rows().at(-1)?.key)
									}
								/>
							)}
						</Index>
					</scrollbox>
					<box
						flexDirection="column"
						height={5}
						flexShrink={0}
						paddingLeft={1}
						paddingRight={1}
						border={['top']}
						borderStyle={inputFocused() ? tactical.chrome.frameStyle : tactical.chrome.panelStyle}
						borderColor={inputFocused() ? tactical.color.coreBright : tactical.chrome.border}
						backgroundColor={inputFocused() ? tactical.color.raised : tactical.color.panel}
					>
						<box flexDirection="row" height={3} flexShrink={0} gap={1} alignItems="flex-start">
							<text wrapMode="none">
								<span style={{ fg: tactical.color.grid }}>›</span>
								<span style={{ fg: tactical.color.text }}> [</span>
								<span style={{ fg: tactical.color.coreBright }}>{verbLabel()}</span>
								<span style={{ fg: tactical.color.text }}>] </span>
							</text>
							<textarea
								ref={(renderable) => {
									editor = renderable
								}}
								flexGrow={1}
								height={2}
								focused={inputFocused()}
								initialValue={draft()}
								placeholder={inputFocused() ? 'MESSAGE ROOT' : 'TAB TO FOCUS'}
								placeholderColor={tactical.color.grid}
								textColor={tactical.color.text}
								focusedTextColor={tactical.color.coreBright}
								backgroundColor={tactical.color.panel}
								focusedBackgroundColor={tactical.color.raised}
								cursorColor={tactical.color.core}
								cursorStyle={{ style: 'line', blinking: true }}
								onSubmit={submitDraft}
								onContentChange={setDraft}
							/>
						</box>
						<box flexDirection="row" height={1} flexShrink={0}>
							<text
								fg={props.notice() === null ? tactical.color.grid : tactical.color.coreBright}
								wrapMode="none"
							>
								{props.notice() ?? ''}
							</text>
							<box flexGrow={1} />
							<text fg={tactical.color.textDim} wrapMode="none">
								{inputFocused() ? 'ENTER SEND · SHIFT+ENTER NEWLINE · TAB TYPE' : 'TAB INPUT'}
							</text>
						</box>
						<Show when={isCompacting()}>
							<box
								position="absolute"
								top={0}
								left={0}
								width="100%"
								height={4}
								zIndex={5}
								paddingLeft={1}
								flexDirection="column"
								justifyContent="center"
								backgroundColor={tactical.color.raised}
							>
								<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
									⧗ COMPACTING CONTEXT
								</text>
								<text fg={tactical.color.textDim} wrapMode="none">
									SUMMARIZING CONVERSATION
								</text>
							</box>
						</Show>
					</box>
				</box>
				<box
					flexGrow={1}
					flexDirection="column"
					border
					borderStyle={
						paneState('context') === 'focused'
							? tactical.chrome.frameStyle
							: paneState('context') === 'selected'
								? 'double'
								: tactical.chrome.panelStyle
					}
					borderColor={paneBorderColor('context')}
					title={paneTitle(
						'context',
						`${TUI_CONTEXT_TITLE.trim()} · [${mode() === 'live' ? TUI_LIVE_BADGE : TUI_INSPECT_BADGE}] · ${contextSubject()}`,
					)}
					titleColor={paneTitleColor('context')}
					backgroundColor={tactical.color.panel}
				>
					<scrollbox
						ref={(renderable) => {
							contextScroller = renderable
						}}
						flexGrow={1}
						scrollY
						stickyScroll={mode() === 'live'}
						stickyStart="bottom"
						scrollbarOptions={{
							showArrows: false,
							trackOptions: {
								backgroundColor: tactical.color.textFaint,
								foregroundColor: tactical.color.gridDim,
							},
						}}
					>
						<Index
							each={visibleContextRows()}
							fallback={
								<box paddingLeft={1}>
									<text fg={tactical.color.textFaint}>
										{replayIsReady(props.state().replay)
											? 'WAITING FOR ROOT-AGENT OUTPUT'
											: 'LOADING CONVERSATION HISTORY'}
									</text>
								</box>
							}
						>
							{(row) => (
								<Show when={mode() === 'inspect'} fallback={<EventRow row={row} />}>
									<EventDetail row={row} />
								</Show>
							)}
						</Index>
					</scrollbox>
				</box>
			</box>

			<box
				flexDirection="row"
				height={2}
				paddingX={1}
				gap={2}
				alignItems="center"
				border={['top']}
				borderStyle={tactical.chrome.frameStyle}
				borderColor={tactical.chrome.border}
			>
				<KeyHint keyName="H/L" label="PANES" />
				<KeyHint keyName="↵" label="FOCUS/SEND" />
				<KeyHint keyName="ESC" label="BACK" />
				<KeyHint keyName="^C" label="INTERRUPT" />
				<KeyHint keyName="Q" label="QUIT" />
				<box flexGrow={1} />
				<text fg={tactical.color.textDim} wrapMode="none">
					FX//
				</text>
				<Toggle label="B" name="GLOW" enabled={toggles().glow} verbose={verboseFooter()} />
				<Toggle label="S" name="SCAN" enabled={toggles().scanlines} verbose={verboseFooter()} />
				<Toggle label="G" name="GLITCH" enabled={toggles().glitch} verbose={verboseFooter()} />
				<Toggle
					label="V"
					name="VIGNETTE"
					enabled={toggles().vignette !== 'off'}
					status={toggles().vignette.toUpperCase()}
					verbose={verboseFooter()}
				/>
				<Toggle label="R" name="CRT-BAR" enabled={toggles().rollingBar} verbose={verboseFooter()} />
			</box>
			<box
				position="absolute"
				right={1}
				bottom={2}
				zIndex={10}
				width={props.sessionId.length + 2}
				height={1}
				justifyContent="center"
				backgroundColor={tactical.color.panel}
				onMouseDown={(event) => {
					event.preventDefault()
					props.onCopySessionId?.()
				}}
			>
				<text fg={tactical.color.coreBright} wrapMode="none">
					{props.sessionId}
				</text>
			</box>
		</box>
	)
}
