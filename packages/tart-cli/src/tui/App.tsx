/** @jsxImportSource @opentui/solid */
import { installPostFx, nextVignetteMode, type FxToggles } from '@humanlayer/tart-tui-theme/postfx'
import type { ThemeId } from '@humanlayer/tart-tui-theme/themes'
import { TextAttributes, type KeyEvent, type ScrollBoxRenderable, type TextareaRenderable } from '@opentui/core'
import { registerManagedTextareaLayer } from '@opentui/keymap/addons/opentui'
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid'
import { createEffect, createMemo, createSignal, Index, onCleanup, Show, type Accessor } from 'solid-js'

import { ActivityIndicator, type ActivityState } from './ActivityIndicator'
import { CommandPalette, type TuiCommand } from './CommandPalette'
import { nextRootInputVerb, normalizeRootInputVerb, rootInputVerbLabel, type RootInputVerb } from './Converse'
import { EventDetail, EventIndexRow, EventRow, rowVisual } from './EventViews'
import { MetaRail } from './MetaRail'
import {
	contextMode,
	followLive,
	initialNavigationState,
	jumpSelection,
	moveSelection,
	reconcileSelection,
	type NavigationState,
} from './Navigation'
import { NewSessionModal } from './NewSessionModal'
import { conversationRows, makeSessionStateFromEntries, replayIsReady, type SessionState } from './SessionState'
import { SkillsRail } from './SkillsRail'
import { metaCounts, skillViews, subagentViews } from './Subagents'
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
	readonly targetNotice?: Accessor<{ readonly agentId: string; readonly text: string } | null>
	readonly compacting?: Accessor<boolean>
	readonly initialInputFocused?: boolean
	readonly onSubmit: (verb: RootInputVerb, text: string) => void
	readonly onCompact: () => void
	readonly onInterrupt: () => void
	readonly onNewSession?: (cwd: string) => void
	readonly onBackToSessions?: () => void
	readonly onCopySessionId?: () => void
	readonly toggles?: Accessor<FxToggles>
	readonly setToggles?: (update: (current: FxToggles) => FxToggles) => void
	readonly onCycleTheme?: () => void
	readonly onSelectTheme?: (theme: ThemeId) => void
	readonly onStop?: () => void
	readonly onTargetSubmit?: (agentId: string, text: string, verb: RootInputVerb) => void
	readonly onTargetInterrupt?: (agentId: string) => void
	readonly onInjectSkill?: (skill: string, agentId: string | null) => void
	readonly initialSelectedAgentId?: string
}

export const TuiApp = (props: TuiAppProps) => {
	const renderer = useRenderer()
	const dimensions = useTerminalDimensions()
	const [draft, setDraft] = createSignal('')
	const [paletteOpen, setPaletteOpen] = createSignal(false)
	const [newSessionOpen, setNewSessionOpen] = createSignal(false)
	const [railTab, setRailTab] = createSignal<'subagents' | 'meta' | 'skills'>('subagents')
	const [selectedAgentId, setSelectedAgentId] = createSignal<string | null>(props.initialSelectedAgentId ?? null)
	const [targetDraft, setTargetDraft] = createSignal('')
	const [targetFocused, setTargetFocused] = createSignal(false)
	const [targetVerb, setTargetVerb] = createSignal<RootInputVerb>('send')
	const [selectedSkill, setSelectedSkill] = createSignal(0)
	const [confirmSkill, setConfirmSkill] = createSignal<string | null>(null)
	const { toggles, setToggles } = createFxControls(props.toggles, props.setToggles)
	const [inputFocused, setInputFocused] = createSignal(props.initialInputFocused === true)
	const [verb, setVerb] = createSignal<RootInputVerb>('send')
	const [navigation, setNavigation] = createSignal<NavigationState>(
		props.initialInputFocused === true ? { ...initialNavigationState, level: 'input' } : initialNavigationState,
	)
	let editor: TextareaRenderable | undefined
	let targetEditor: TextareaRenderable | undefined
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
	const removeTargetInputKeymap = registerManagedTextareaLayer(keymap, renderer, {
		enabled: () => targetFocused() && renderer.currentFocusedEditor === targetEditor,
		bindings: [
			{ key: 'return', cmd: 'input.submit' },
			{ key: 'shift+return', cmd: 'input.newline' },
			{ key: 'ctrl+return', cmd: 'input.newline' },
			{ key: 'alt+return', cmd: 'input.newline' },
			{ key: 'ctrl+j', cmd: 'input.newline' },
		],
	})
	onCleanup(removeInputKeymap)
	onCleanup(removeTargetInputKeymap)
	const rows = createMemo(() => conversationRows(props.state()))
	const agents = createMemo(() =>
		subagentViews(
			props.state().allEntries,
			props.state().allEntries.find((e) => e._tag === 'session_started')?.rootAgentId ??
				props.state().allEntries[0]?.agentId!,
		),
	)
	const selectedAgent = createMemo(() => agents().find((agent) => agent.agentId === selectedAgentId()))
	const agentRows = createMemo(() => {
		const agent = selectedAgent()
		return agent === undefined ? [] : conversationRows(makeSessionStateFromEntries(agent.entries, agent.agentId))
	})
	const meta = createMemo(() => metaCounts(props.state().allEntries, agents()))
	const rootAgentId = createMemo(
		() =>
			props.state().allEntries.find((entry) => entry._tag === 'session_started')?.rootAgentId ??
			props.state().allEntries[0]?.agentId!,
	)
	const skillTargetAgent = createMemo(() => selectedAgent())
	const skills = createMemo(() => skillViews(props.state().allEntries, skillTargetAgent()?.agentId ?? rootAgentId()))
	const nextRailTab = (): void => {
		setRailTab((current) => (current === 'subagents' ? 'meta' : current === 'meta' ? 'skills' : 'subagents'))
	}
	const rowKeys = createMemo(() => rows().map((row) => row.key))
	const mode = createMemo(() => contextMode(navigation(), rowKeys()))
	const selectedRow = createMemo(() => {
		const selectedKey = navigation().selectedKey
		return selectedKey === null ? undefined : rows().find((row) => row.key === selectedKey)
	})
	const eventSelectedAgent = createMemo(() => {
		const toolCallId = selectedRow()?.toolCallId
		return toolCallId === null || toolCallId === undefined
			? undefined
			: agents().find((agent) =>
					agent.entries.some((entry) => entry._tag === 'agent_started' && entry.toolCallId === toolCallId),
				)
	})
	const focusedAgent = createMemo(() => selectedAgent() ?? eventSelectedAgent())
	const targetStatus = createMemo<SessionState['status']>(() =>
		focusedAgent()?.status === 'running' ? 'RUNNING' : 'IDLE',
	)
	const targetVerbLabel = createMemo(() =>
		focusedAgent()?.status === 'running' ? rootInputVerbLabel(targetVerb()) : 'RESUME',
	)
	const visibleContextRows = createMemo(() => {
		const agent = focusedAgent()
		if (agent !== undefined) return conversationRows(makeSessionStateFromEntries(agent.entries, agent.agentId))
		const selected = selectedRow()
		return mode() === 'inspect' && selected !== undefined ? [selected] : rows()
	})
	const eventPaneWidth = createMemo(() => (dimensions().width < 84 ? '40%' : '32%'))
	const railPaneWidth = createMemo(() => (dimensions().width < 118 ? '26%' : '28%'))
	const contextPaneWidth = createMemo(() => {
		const eventRatio = dimensions().width < 84 ? 0.4 : 0.32
		const railRatio = dimensions().width < 118 ? 0.26 : 0.28
		return Math.floor(dimensions().width * (1 - eventRatio - railRatio))
	})
	const verboseFooter = createMemo(() => dimensions().width >= 120)
	const verbLabel = createMemo(() => rootInputVerbLabel(verb()))
	const isCompacting = createMemo(() => props.compacting?.() === true)
	const sessionActivity = createMemo<ActivityState>(() =>
		isCompacting()
			? 'compacting'
			: props.state().status === 'RUNNING' || meta().running > 0
				? 'running'
				: props.state().status === 'STOPPED'
					? 'stopped'
					: 'ready',
	)
	const runningCount = createMemo(() => meta().running + (props.state().status === 'RUNNING' ? 1 : 0))
	const sessionActivityLabel = createMemo(() => {
		if (sessionActivity() === 'running') return runningCount() > 1 ? `${runningCount()} RUNNING` : 'RUNNING'
		return sessionActivity().toUpperCase()
	})
	const paletteCommands = createMemo<ReadonlyArray<TuiCommand>>(() => {
		const themes = themeCommands(props.onSelectTheme)
		const fx = fxCommands({ toggles, setToggles })
		const commands: Array<TuiCommand> = [
			{
				id: 'new',
				title: 'New session',
				category: 'NAVIGATE',
				shortcut: '^N',
				run: () => setNewSessionOpen(true),
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
	const paneTitle = (pane: NavigationState['pane'], label: string, maxWidth?: number): string => {
		const state = paneState(pane)
		const prefix = state === 'focused' ? ' ◆ ' : state === 'selected' ? ' ▸ ' : ' '
		const suffix = state === 'focused' ? ' · [FOCUSED] ' : state === 'selected' ? ' · [SELECTED] ' : ' '
		const available = maxWidth === undefined ? label.length : Math.max(1, maxWidth - prefix.length - suffix.length)
		const fittedLabel =
			label.length <= available ? label : available === 1 ? '…' : `${label.slice(0, available - 1).trimEnd()}…`
		return `${prefix}${fittedLabel}${suffix}`
	}
	const contextSubject = createMemo(() => {
		const selected = selectedRow()
		if (focusedAgent() !== undefined) return `${focusedAgent()!.type} · ${focusedAgent()!.description}`
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
	const submitTargetDraft = (): void => {
		const value = (targetEditor?.plainText ?? targetDraft()).trim()
		const agent = selectedAgent()
		if (value.length === 0 || agent === undefined) return
		props.onTargetSubmit?.(agent.agentId, value, targetVerb())
		setTargetDraft('')
		targetEditor?.setText('')
		targetEditor?.focus()
	}

	createEffect(() => setVerb((current) => normalizeRootInputVerb(props.state().status, current)))
	createEffect(() => setTargetVerb((current) => normalizeRootInputVerb(targetStatus(), current)))
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
		if (paletteOpen() || newSessionOpen()) return
		if (confirmSkill() !== null) {
			key.preventDefault()
			if (key.name === 'y') {
				props.onInjectSkill?.(confirmSkill()!, skillTargetAgent()?.agentId ?? null)
				setConfirmSkill(null)
			} else if (key.name === 'n' || key.name === 'escape') setConfirmSkill(null)
			return
		}
		if (key.ctrl && key.name === 'a') {
			key.preventDefault()
			const available = agents()
			if (available.length === 0) return
			const index = available.findIndex((agent) => agent.agentId === selectedAgentId())
			setSelectedAgentId(available[(index + 1) % available.length]!.agentId)
			return
		}
		if (key.ctrl && key.name === 'c') {
			key.preventDefault()
			const agent = focusedAgent()
			if (agent === undefined) props.onInterrupt()
			else if (agent.status === 'running') props.onTargetInterrupt?.(agent.agentId)
			return
		}
		if (key.ctrl && key.name === 'n') {
			key.preventDefault()
			setNewSessionOpen(true)
			return
		}
		if ((key.ctrl || key.meta) && key.name === 'k') {
			key.preventDefault()
			setPaletteOpen(true)
			return
		}
		if (targetFocused()) {
			if (key.name === 'escape') {
				key.preventDefault()
				setTargetFocused(false)
				targetEditor?.blur()
				return
			}
			if (key.name === 'enter' || key.name === 'return') {
				key.preventDefault()
				submitTargetDraft()
				return
			}
			if (key.name === 'tab') {
				key.preventDefault()
				setTargetVerb((current) => nextRootInputVerb(targetStatus(), current))
				return
			}
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
			if (key.name === 'tab' && navigation().pane === 'subagents') {
				key.preventDefault()
				nextRailTab()
				return
			}
			if (
				navigation().pane === 'context' &&
				focusedAgent() !== undefined &&
				(key.name === 'tab' || key.name === 'enter' || key.name === 'return')
			) {
				key.preventDefault()
				setTargetFocused(true)
				targetEditor?.focus()
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
			} else if (navigation().pane === 'context') {
				if ((key.name === 'enter' || key.name === 'return') && focusedAgent() !== undefined) {
					key.preventDefault()
					setTargetFocused(true)
					targetEditor?.focus()
					return
				}
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
			if (navigation().pane === 'subagents') {
				if (railTab() === 'skills') {
					if (key.name === 'j' || key.name === 'down' || key.name === 'k' || key.name === 'up') {
						key.preventDefault()
						const delta = key.name === 'j' || key.name === 'down' ? 1 : -1
						setSelectedSkill((current) => Math.max(0, Math.min(skills().length - 1, current + delta)))
						return
					}
					if (key.name === 'enter' || key.name === 'return') {
						key.preventDefault()
						const skill = skills()[selectedSkill()]
						if (skill !== undefined) setConfirmSkill(skill.name)
						return
					}
				}
				if (key.name === 'j' || key.name === 'down' || key.name === 'k' || key.name === 'up') {
					key.preventDefault()
					const available = agents()
					if (available.length === 0) return
					const current = available.findIndex((agent) => agent.agentId === selectedAgentId())
					const delta = key.name === 'j' || key.name === 'down' ? 1 : -1
					const next = Math.max(0, Math.min(available.length - 1, (current < 0 ? 0 : current) + delta))
					setSelectedAgentId(available[next]!.agentId)
					return
				}
			}
			pendingG = false
			return
		}

		switch (key.name) {
			case 'a': {
				const available = agents()
				if (available.length === 0) return
				const index = available.findIndex((agent) => agent.agentId === selectedAgentId())
				setSelectedAgentId(available[(index + 1) % available.length]!.agentId)
				return
			}
			case 'escape':
				key.preventDefault()
				if (selectedAgentId() !== null) {
					setSelectedAgentId(null)
					return
				}
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
				} else if (navigation().pane === 'subagents') {
					key.preventDefault()
					nextRailTab()
				} else if (focusedAgent() !== undefined) {
					key.preventDefault()
					setTargetFocused(true)
					targetEditor?.focus()
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
				setNavigation((current) => ({ ...current, pane: current.pane === 'subagents' ? 'context' : 'events' }))
				return
			case 'l':
			case 'right':
				key.preventDefault()
				setNavigation((current) => ({ ...current, pane: current.pane === 'events' ? 'context' : 'subagents' }))
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
					<box flexDirection="row" gap={1}>
						<text fg={tactical.color.textFaint} wrapMode="none">
							SESSION
						</text>
						<ActivityIndicator state={sessionActivity()} label={sessionActivityLabel()} />
					</box>
					<text wrapMode="none">
						<span style={{ fg: tactical.color.textFaint }}>{`${props.mode} · ${props.profile} · `}</span>
						<span style={{ fg: tactical.color.text }}>{props.state().model}</span>
					</text>
				</box>
			</box>

			<box flexGrow={1} flexDirection="row">
				<box
					width={eventPaneWidth()}
					flexShrink={0}
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
						contextPaneWidth() - 8,
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
								<Show
									when={focusedAgent() === undefined && mode() === 'inspect'}
									fallback={<EventRow row={row} />}
								>
									<EventDetail row={row} />
								</Show>
							)}
						</Index>
					</scrollbox>
					<Show when={focusedAgent()}>
						<box
							height={5}
							flexShrink={0}
							flexDirection="column"
							border={['top']}
							borderColor={targetFocused() ? tactical.color.coreBright : tactical.chrome.border}
							backgroundColor={targetFocused() ? tactical.color.raised : tactical.color.panel}
							paddingX={1}
						>
							<box height={1} flexDirection="row">
								<text fg={tactical.color.coreBright} wrapMode="none">
									{`[${targetVerbLabel()}]`}
								</text>
								<box flexGrow={1} />
								<Show when={focusedAgent()!.status === 'running'}>
									<text
										fg={tactical.color.textDim}
										wrapMode="none"
										onMouseDown={() => props.onTargetInterrupt?.(focusedAgent()!.agentId)}
									>
										^C INTERRUPT
									</text>
								</Show>
							</box>
							<textarea
								ref={(value: TextareaRenderable) => (targetEditor = value)}
								height={2}
								focused={targetFocused()}
								placeholder={targetFocused() ? 'MESSAGE SUBAGENT' : 'TAB OR ENTER TO FOCUS'}
								initialValue={targetDraft()}
								onContentChange={() => setTargetDraft(targetEditor?.plainText ?? '')}
								placeholderColor={tactical.color.grid}
								textColor={tactical.color.text}
								focusedTextColor={tactical.color.coreBright}
								backgroundColor={tactical.color.panel}
								focusedBackgroundColor={tactical.color.raised}
								cursorColor={tactical.color.coreBright}
								cursorStyle={{ style: 'line', blinking: true }}
								onSubmit={submitTargetDraft}
							/>
							<text fg={tactical.color.coreBright} wrapMode="none" truncate>
								{props.targetNotice?.()?.agentId === focusedAgent()!.agentId
									? props.targetNotice?.()?.text
									: ''}
							</text>
						</box>
					</Show>
					<Show when={focusedAgent()}>
						<box
							position="absolute"
							right={1}
							bottom={-1}
							zIndex={10}
							width={focusedAgent()!.agentId.length + 2}
							height={1}
							justifyContent="center"
							backgroundColor={tactical.color.panel}
						>
							<text fg={tactical.color.coreBright} wrapMode="none">
								{focusedAgent()!.agentId}
							</text>
						</box>
					</Show>
				</box>
				<box
					width={railPaneWidth()}
					flexShrink={0}
					flexDirection="column"
					border
					borderStyle={
						paneState('subagents') === 'focused'
							? tactical.chrome.frameStyle
							: paneState('subagents') === 'selected'
								? 'double'
								: tactical.chrome.panelStyle
					}
					borderColor={paneBorderColor('subagents')}
					title={paneTitle('subagents', railTab().toUpperCase())}
					titleColor={paneTitleColor('subagents')}
					backgroundColor={tactical.color.panel}
				>
					<box height={1} flexDirection="row" gap={2} paddingLeft={1}>
						<text
							fg={railTab() === 'subagents' ? tactical.color.coreBright : tactical.color.textDim}
							onMouseDown={() => setRailTab('subagents')}
						>
							SUBAGENTS
						</text>
						<text
							fg={railTab() === 'meta' ? tactical.color.coreBright : tactical.color.textDim}
							onMouseDown={() => setRailTab('meta')}
						>
							META
						</text>
						<text
							fg={railTab() === 'skills' ? tactical.color.coreBright : tactical.color.textDim}
							onMouseDown={() => setRailTab('skills')}
						>
							SKILLS
						</text>
						<box flexGrow={1} />
						<text fg={tactical.color.grid}>{meta().running} RUN</text>
					</box>
					<Show
						when={railTab() === 'subagents'}
						fallback={
							railTab() === 'meta' ? (
								<MetaRail meta={meta()} />
							) : (
								<SkillsRail
									skills={skills()}
									selected={selectedSkill()}
									focused={paneState('subagents') === 'focused'}
									onSelect={setSelectedSkill}
								/>
							)
						}
					>
						<scrollbox flexGrow={1} scrollY>
							<Index each={agents()} fallback={<text fg={tactical.color.textFaint}> NO SUBAGENTS</text>}>
								{(agent) => (
									<box
										paddingLeft={1}
										height={2}
										flexDirection="column"
										onMouseDown={() => setSelectedAgentId(agent().agentId)}
									>
										<box height={1} flexDirection="row" gap={1}>
											<text width={2} fg={tactical.color.coreBright} wrapMode="none">
												{selectedAgentId() === agent().agentId ? '▸' : ' '}
											</text>
											<text
												flexGrow={1}
												wrapMode="none"
												truncate
												fg={
													selectedAgentId() === agent().agentId
														? tactical.color.coreBright
														: tactical.color.text
												}
											>
												{agent().type}
											</text>
											<ActivityIndicator
												state={
													agent().status === 'running'
														? 'running'
														: agent().status === 'done'
															? 'ready'
															: agent().status === 'error'
																? 'error'
																: 'stopped'
												}
												label={
													agent().status === 'done' ? 'DONE' : agent().status.toUpperCase()
												}
												width={12}
											/>
										</box>
										<text fg={tactical.color.textDim} paddingLeft={3} wrapMode="none" truncate>
											{agent().description}
										</text>
									</box>
								)}
							</Index>
						</scrollbox>
					</Show>
				</box>
			</box>
			<box
				flexDirection="row"
				height={2}
				paddingX={1}
				gap={1}
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
			<Show when={newSessionOpen()}>
				<NewSessionModal
					cwd={props.cwd}
					onClose={() => setNewSessionOpen(false)}
					onSubmit={(cwd) => {
						setNewSessionOpen(false)
						props.onNewSession?.(cwd)
					}}
				/>
			</Show>
			<Show when={confirmSkill()}>
				<box
					position="absolute"
					top={8}
					left={Math.max(2, Math.floor((dimensions().width - 68) / 2))}
					width={Math.min(68, dimensions().width - 4)}
					height={9}
					zIndex={70}
					padding={1}
					flexDirection="column"
					border
					borderStyle="double"
					borderColor={tactical.color.coreBright}
					backgroundColor={tactical.color.panel}
				>
					<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD}>
						INJECT SKILL?
					</text>
					<box height={1} />
					<text fg={tactical.color.text} wrapMode="none" truncate>
						{`${confirmSkill()} → ${skillTargetAgent() === undefined ? 'Primary Agent' : `${skillTargetAgent()!.type} Agent`}`}
					</text>
					<text wrapMode="none" truncate>
						<span style={{ fg: tactical.color.textDim }}>Description: </span>
						<span style={{ fg: tactical.color.text }}>
							{skillTargetAgent()?.description ?? 'Root session agent'}
						</span>
					</text>
					<box height={1} />
					<text fg={tactical.color.textDim}>Add this skill's instructions to the agent context?</text>
					<text fg={tactical.color.coreBright}>Y confirm · N cancel</text>
				</box>
			</Show>
		</box>
	)
}
