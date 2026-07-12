/** @jsxImportSource @opentui/solid */
import { installPostFx, nextVignetteMode, type FxToggles } from '@humanlayer/tart-tui-theme/postfx'
import type { ThemeId } from '@humanlayer/tart-tui-theme/themes'
import { TextAttributes, type KeyEvent, type ScrollBoxRenderable, type TextareaRenderable } from '@opentui/core'
import { registerManagedTextareaLayer } from '@opentui/keymap/addons/opentui'
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid'
import { createEffect, createMemo, createSignal, Index, onCleanup, Show, type Accessor } from 'solid-js'

import { CommandPalette, type TuiCommand } from './CommandPalette'
import { nextRootInputVerb, normalizeRootInputVerb, rootInputVerbLabel, type RootInputVerb } from './Converse'
import { EventDetail, EventIndexRow, EventRow, rowVisual } from './EventViews'
import {
	contextMode,
	followLive,
	initialNavigationState,
	jumpSelection,
	moveSelection,
	reconcileSelection,
	type NavigationState,
} from './Navigation'
import { conversationRows, replayIsReady, type SessionState } from './SessionState'
import { theme as tactical } from './ThemeState'
import { TUI_CONTEXT_TITLE, TUI_INSPECT_BADGE, TUI_LIVE_BADGE } from './TuiChrome'
import { createFxControls, FxFooter, fxCommands, KeyHint, themeCommands } from './TuiControls'

export type TuiAppProps = {
	readonly state: Accessor<SessionState>
	readonly cwd: string
	readonly sessionId: string
	readonly mode: string
	readonly profile: string
	readonly notice: Accessor<string | null>
	readonly compacting?: Accessor<boolean>
	readonly initialInputFocused?: boolean
	readonly onSubmit: (verb: RootInputVerb, text: string) => void
	readonly onCompact: () => void
	readonly onInterrupt: () => void
	readonly onNewSession?: () => void
	readonly onBackToSessions?: () => void
	readonly onCopySessionId?: () => void
	readonly toggles?: Accessor<FxToggles>
	readonly setToggles?: (update: (current: FxToggles) => FxToggles) => void
	readonly onCycleTheme?: () => void
	readonly onSelectTheme?: (theme: ThemeId) => void
	readonly onStop?: () => void
}

const statusColor = (status: SessionState['status']): string =>
	status === 'RUNNING' ? tactical.color.coreBright : status === 'STOPPED' ? tactical.color.alert : tactical.color.grid

export const TuiApp = (props: TuiAppProps) => {
	const renderer = useRenderer()
	const dimensions = useTerminalDimensions()
	const [draft, setDraft] = createSignal('')
	const [paletteOpen, setPaletteOpen] = createSignal(false)
	const { toggles, setToggles } = createFxControls(props.toggles, props.setToggles)
	const [inputFocused, setInputFocused] = createSignal(props.initialInputFocused === true)
	const [verb, setVerb] = createSignal<RootInputVerb>('send')
	const [navigation, setNavigation] = createSignal<NavigationState>(
		props.initialInputFocused === true ? { ...initialNavigationState, level: 'input' } : initialNavigationState,
	)
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
	const paletteCommands = createMemo<ReadonlyArray<TuiCommand>>(() => {
		const themes = themeCommands(props.onSelectTheme)
		const fx = fxCommands({ toggles, setToggles })
		const commands: Array<TuiCommand> = [
			{
				id: 'new',
				title: 'New session',
				category: 'NAVIGATE',
				shortcut: '^N',
				run: () => props.onNewSession?.(),
			},
			{ id: 'resume', title: 'Resume session…', category: 'NAVIGATE', run: () => props.onBackToSessions?.() },
			{ id: 'back', title: 'Return to sessions', category: 'NAVIGATE', run: () => props.onBackToSessions?.() },
			{ id: 'copy', title: 'Copy session ID', category: 'SESSION', run: () => props.onCopySessionId?.() },
			...fx.slice(0, 4),
			{ id: 'theme', title: 'Switch theme…', category: 'VIEW', shortcut: 'T', children: themes },
			fx[4],
			{ id: 'quit', title: 'Quit Tart', category: 'APPLICATION', shortcut: 'Q', run: () => renderer.destroy() },
		]
		if (props.state().status === 'RUNNING') {
			commands.push({ id: 'stop', title: 'Stop gracefully', category: 'SESSION', run: () => props.onStop?.() })
			commands.push({
				id: 'interrupt',
				title: 'Interrupt all',
				category: 'SESSION',
				shortcut: '^C',
				run: props.onInterrupt,
			})
		} else if (!isCompacting()) {
			commands.push({ id: 'compact', title: 'Compact now', category: 'SESSION', run: props.onCompact })
		}
		return commands
	})
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
		if (paletteOpen()) return
		if (key.ctrl && key.name === 'c') {
			key.preventDefault()
			props.onInterrupt()
			return
		}
		if (key.ctrl && key.name === 'n') {
			key.preventDefault()
			props.onNewSession?.()
			return
		}
		if ((key.ctrl || key.meta) && key.name === 'k') {
			key.preventDefault()
			setPaletteOpen(true)
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
			case 'escape':
				key.preventDefault()
				props.onBackToSessions?.()
				return
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
				return
			case 't':
				props.onCycleTheme?.()
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
								height="100%"
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
				<KeyHint keyName="ESC" label={navigation().level === 'pane' ? 'SESSIONS' : 'BACK'} />
				<KeyHint keyName="^N" label="NEW" />
				<KeyHint keyName="^K" label="COMMANDS" />
				<KeyHint keyName="T" label="THEME" />
				<KeyHint keyName="^C" label="INTERRUPT" />
				<KeyHint keyName="Q" label="QUIT" />
				<box flexGrow={1} />
				<FxFooter toggles={toggles()} verbose={verboseFooter()} />
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
			<Show when={paletteOpen()}>
				<CommandPalette commands={paletteCommands()} onClose={() => setPaletteOpen(false)} />
			</Show>
		</box>
	)
}
