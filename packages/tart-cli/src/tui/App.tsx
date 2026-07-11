/** @jsxImportSource @opentui/solid */
import { installPostFx, ALL_FX_ON, nextVignetteMode, type FxToggles } from '@humanlayer/tart-tui-theme/postfx'
import { tactical } from '@humanlayer/tart-tui-theme/tactical'
import { TextAttributes, type KeyEvent } from '@opentui/core'
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid'
import { createEffect, createMemo, createSignal, Index, onCleanup, type Accessor } from 'solid-js'

import { containsMarkdown } from './MarkdownDetection'
import { MarkdownText } from './MarkdownText'
import { conversationRows, replayIsReady, type ConversationRow, type SessionState } from './SessionState'
import { TUI_CONTEXT_TITLE, TUI_LIVE_BADGE } from './TuiChrome'

export type TuiAppProps = {
	readonly state: Accessor<SessionState>
	readonly cwd: string
	readonly sessionId: string
	readonly mode: string
	readonly profile: string
	readonly onInterrupt: () => void
}

const statusColor = (status: SessionState['status']): string =>
	status === 'RUNNING' ? tactical.color.coreBright : status === 'STOPPED' ? tactical.color.alert : tactical.color.grid

const KeyHint = (props: { readonly keyName: string; readonly label: string }) => (
	<text wrapMode="none">
		<span style={{ fg: tactical.color.coreBright }}>{props.keyName}</span>
		<span style={{ fg: tactical.color.textFaint }}>{` ${props.label}`}</span>
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
		{props.verbose ? <span style={{ fg: tactical.color.textFaint }}>{` ${props.name}`}</span> : null}
		<span style={{ fg: tactical.color.textFaint }}>:</span>
		<span style={{ fg: props.enabled ? tactical.color.grid : tactical.color.textFaint }}>
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

export const TuiApp = (props: TuiAppProps) => {
	const renderer = useRenderer()
	const dimensions = useTerminalDimensions()
	const [toggles, setToggles] = createSignal<FxToggles>(ALL_FX_ON)
	const rows = createMemo(() => conversationRows(props.state()))
	const verboseFooter = createMemo(() => dimensions().width >= 120)

	createEffect(() => {
		renderer.setBackgroundColor(tactical.color.void)
		const removeFx = installPostFx(renderer, tactical, toggles())
		onCleanup(removeFx)
	})

	useKeyboard((key: KeyEvent) => {
		if (key.eventType === 'release') return
		if (key.ctrl && key.name === 'c') {
			renderer.destroy()
			props.onInterrupt()
			return
		}

		switch (key.name) {
			case 'q':
			case 'escape':
				renderer.destroy()
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

			<box
				flexGrow={1}
				flexDirection="column"
				border
				borderStyle={tactical.chrome.panelStyle}
				borderColor={tactical.chrome.border}
				title={`${TUI_CONTEXT_TITLE}· [${TUI_LIVE_BADGE}] `}
				titleColor={tactical.chrome.title}
				bottomTitle={` ${props.sessionId} `}
				bottomTitleAlignment="right"
				backgroundColor={tactical.color.panel}
			>
				<scrollbox
					flexGrow={1}
					scrollY
					stickyScroll
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
						each={rows()}
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
						{(row) => <EventRow row={row} />}
					</Index>
				</scrollbox>
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
				<KeyHint keyName="Q/ESC" label="QUIT" />
				<KeyHint keyName="^C" label="INTERRUPT + QUIT" />
				<box flexGrow={1} />
				<text fg={tactical.color.textFaint} wrapMode="none">
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
		</box>
	)
}
