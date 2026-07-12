/** @jsxImportSource @opentui/solid */
import type { SessionSummary } from '@humanlayer/tart-agent'
import type { SessionId } from '@humanlayer/tart-core'
import { ALL_FX_ON, nextVignetteMode, type FxToggles } from '@humanlayer/tart-tui-theme/postfx'
import { TextAttributes, type KeyEvent } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/solid'
import { createEffect, createMemo, createSignal, Index, Show, type Accessor } from 'solid-js'

import { CommandPalette, type TuiCommand } from './CommandPalette'
import { relativeSessionTime, shortSessionId } from './SessionPickerState'
import { theme as tactical } from './ThemeState'

export type SessionPickerProps = {
	readonly cwd: string
	readonly mode: string
	readonly profile: string
	readonly sessions: Accessor<ReadonlyArray<SessionPickerRow>>
	readonly notice: Accessor<string | null>
	readonly opening: Accessor<boolean>
	readonly onOpen: (sessionId: SessionId) => void
	readonly onDelete: (sessionId: SessionId) => void
	readonly onNew: () => void
	readonly onQuit: () => void
	readonly toggles?: Accessor<FxToggles>
	readonly setToggles?: (update: (current: FxToggles) => FxToggles) => void
	readonly onCycleTheme?: () => void
	readonly onSelectTheme?: (
		theme: 'tactical' | 'wintermute' | 'neuromancer' | 'redalert' | 'covenant' | 'rapture',
	) => void
}

export type SessionPickerRow = SessionSummary & { readonly contextPercent: number | null }

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

export const SessionPicker = (props: SessionPickerProps) => {
	const dimensions = useTerminalDimensions()
	const [selected, setSelected] = createSignal(0)
	const [deleteTarget, setDeleteTarget] = createSignal<SessionPickerRow | null>(null)
	const [paletteOpen, setPaletteOpen] = createSignal(false)
	const [fallbackToggles, setFallbackToggles] = createSignal<FxToggles>({ ...ALL_FX_ON, vignette: 'light' })
	const toggles = () => props.toggles?.() ?? fallbackToggles()
	const setToggles = props.setToggles ?? setFallbackToggles
	const itemCount = createMemo(() => props.sessions().length + 1)
	const showModeProfile = createMemo(() => dimensions().width >= 105)
	const showProviderModel = createMemo(() => dimensions().width >= 130)
	const verboseFooter = createMemo(() => dimensions().width >= 120)
	const pickerHints = createMemo(() =>
		dimensions().width >= 100
			? '↑↓/JK SELECT · ENTER OPEN · X DELETE · ^N NEW · Q QUIT'
			: 'JK SELECT · ↵ OPEN · X DELETE · ^N NEW',
	)
	const modalWidth = createMemo(() => Math.min(70, dimensions().width - 4))
	const modalLeft = createMemo(() => Math.max(2, Math.floor((dimensions().width - modalWidth()) / 2)))
	createEffect(() => setSelected((current) => Math.min(itemCount() - 1, current)))
	const move = (offset: number): void => {
		setSelected((current) => Math.min(itemCount() - 1, Math.max(0, current + offset)))
	}
	const activate = (): void => {
		if (props.opening()) return
		const session = props.sessions()[selected()]
		if (session === undefined) props.onNew()
		else props.onOpen(session.sessionId)
	}
	const paletteCommands = createMemo<ReadonlyArray<TuiCommand>>(() => {
		const themeCommands: ReadonlyArray<TuiCommand> = (
			['tactical', 'wintermute', 'neuromancer', 'redalert', 'covenant', 'rapture'] as const
		).map((id) => ({
			id: `theme.${id}`,
			title: id === 'redalert' ? 'Red Alert' : id.charAt(0).toUpperCase() + id.slice(1),
			category: 'VIEW',
			run: () => props.onSelectTheme?.(id),
		}))
		const commands: Array<TuiCommand> = [
			{ id: 'new', title: 'New session', category: 'NAVIGATE', shortcut: '^N', run: props.onNew },
			{ id: 'open', title: 'Open selected session', category: 'NAVIGATE', run: activate },
			{
				id: 'glow',
				title: `Turn glow ${toggles().glow ? 'off' : 'on'}`,
				category: 'VIEW',
				shortcut: 'B',
				run: () => setToggles((value) => ({ ...value, glow: !value.glow })),
			},
			{
				id: 'scan',
				title: `Turn scanlines ${toggles().scanlines ? 'off' : 'on'}`,
				category: 'VIEW',
				shortcut: 'S',
				run: () => setToggles((value) => ({ ...value, scanlines: !value.scanlines })),
			},
			{
				id: 'glitch',
				title: `Turn glitch ${toggles().glitch ? 'off' : 'on'}`,
				category: 'VIEW',
				shortcut: 'G',
				run: () => setToggles((value) => ({ ...value, glitch: !value.glitch })),
			},
			{
				id: 'vignette',
				title: 'Vignette…',
				category: 'VIEW',
				shortcut: 'V',
				children: (['off', 'light', 'heavy'] as const).map((mode) => ({
					id: `vignette.${mode}`,
					title: mode.toUpperCase(),
					category: 'VIEW',
					run: () => setToggles((value) => ({ ...value, vignette: mode })),
				})),
			},
			{ id: 'theme', title: 'Switch theme…', category: 'VIEW', shortcut: 'T', children: themeCommands },
			{
				id: 'bar',
				title: `Turn rolling CRT bar ${toggles().rollingBar ? 'off' : 'on'}`,
				category: 'VIEW',
				shortcut: 'R',
				run: () => setToggles((value) => ({ ...value, rollingBar: !value.rollingBar })),
			},
			{ id: 'quit', title: 'Quit Tart', category: 'APPLICATION', shortcut: 'Q', run: props.onQuit },
		]
		const session = props.sessions()[selected()]
		if (session !== undefined)
			commands.push({
				id: 'delete',
				title: 'Delete selected session…',
				category: 'SESSION',
				shortcut: 'X',
				run: () => setDeleteTarget(session),
			})
		return commands
	})

	useKeyboard((key: KeyEvent) => {
		if (key.eventType === 'release' || props.opening()) return
		if (paletteOpen()) return
		const target = deleteTarget()
		if (target !== null) {
			key.preventDefault()
			if (key.name === 'y') {
				setDeleteTarget(null)
				props.onDelete(target.sessionId)
			} else if (key.name === 'escape' || key.name === 'n') {
				setDeleteTarget(null)
			}
			return
		}
		if (key.ctrl && key.name === 'n') {
			key.preventDefault()
			props.onNew()
			return
		}
		if ((key.ctrl || key.meta) && key.name === 'k') {
			key.preventDefault()
			setPaletteOpen(true)
			return
		}
		switch (key.name) {
			case 'j':
			case 'down':
				key.preventDefault()
				move(1)
				return
			case 'k':
			case 'up':
				key.preventDefault()
				move(-1)
				return
			case 'enter':
			case 'return':
				key.preventDefault()
				activate()
				return
			case 'x': {
				const session = props.sessions()[selected()]
				if (session !== undefined) setDeleteTarget(session)
				return
			}
			case 'q':
				props.onQuit()
				return
			case 't':
				props.onCycleTheme?.()
				return
			case 'b':
				setToggles((value) => ({ ...value, glow: !value.glow }))
				return
			case 's':
				setToggles((value) => ({ ...value, scanlines: !value.scanlines }))
				return
			case 'g':
				setToggles((value) => ({ ...value, glitch: !value.glitch }))
				return
			case 'v':
				setToggles((value) => ({ ...value, vignette: nextVignetteMode(value.vignette) }))
				return
			case 'r':
				setToggles((value) => ({ ...value, rollingBar: !value.rollingBar }))
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
						SESSIONS
					</text>
					<text fg={tactical.color.textDim} wrapMode="none">
						{`// ${props.cwd}`}
					</text>
				</box>
				<box flexGrow={1} />
				<text wrapMode="none">
					<span style={{ fg: tactical.color.textDim }}>{`${props.mode} · ${props.profile} · `}</span>
					<span style={{ fg: tactical.color.grid }}>{`${props.sessions().length} sessions`}</span>
				</text>
			</box>

			<box flexGrow={1} flexDirection="column" paddingX={2} paddingTop={1}>
				<box flexDirection="row" height={2} flexShrink={0}>
					<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
						SESSIONS · NEWEST FIRST
					</text>
					<box flexGrow={1} />
					<text fg={tactical.color.textDim} wrapMode="none">
						{pickerHints()}
					</text>
				</box>
				<box flexDirection="column" flexShrink={0}>
					<box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
						<text fg={tactical.color.textFaint} width={2} wrapMode="none" />
						<text fg={tactical.color.textFaint} width={13} wrapMode="none">
							SESSION
						</text>
						<text fg={tactical.color.textFaint} flexGrow={1} wrapMode="none">
							TITLE
						</text>
						<Show when={showModeProfile()}>
							<text fg={tactical.color.textFaint} width={24} wrapMode="none">
								MODE · PROFILE
							</text>
						</Show>
						<Show when={showProviderModel()}>
							<text fg={tactical.color.textFaint} width={36} wrapMode="none">
								PROVIDER / MODEL
							</text>
						</Show>
						<text fg={tactical.color.textFaint} width={8} wrapMode="none">
							TURNS
						</text>
						<text fg={tactical.color.textFaint} width={10} wrapMode="none">
							CONTEXT
						</text>
						<text fg={tactical.color.textFaint} width={12} wrapMode="none">
							UPDATED
						</text>
					</box>
					<Index each={props.sessions()}>
						{(session, index) => (
							<box
								flexDirection="row"
								height={2}
								paddingLeft={1}
								paddingRight={1}
								alignItems="center"
								backgroundColor={selected() === index ? tactical.color.raised : tactical.color.panel}
								onMouseDown={() => {
									setSelected(index)
									if (!props.opening()) props.onOpen(session().sessionId)
								}}
							>
								<text fg={tactical.color.coreBright} width={2} wrapMode="none">
									{selected() === index ? '▸' : ' '}
								</text>
								<text fg={tactical.color.grid} width={13} wrapMode="none">
									{shortSessionId(session().sessionId)}
								</text>
								<text
									fg={selected() === index ? tactical.color.text : tactical.color.textDim}
									flexGrow={1}
									wrapMode="none"
								>
									{session().title}
								</text>
								<Show when={showModeProfile()}>
									<text fg={tactical.color.textDim} width={24} wrapMode="none">
										{`${session().mode === null ? '--' : `${session().mode}${session().rpi ? '+rpi' : ''}`} · ${session().profile ?? '--'}`}
									</text>
								</Show>
								<Show when={showProviderModel()}>
									<text fg={tactical.color.textDim} width={36} wrapMode="none">
										{`${session().providerId ?? '--'}/${session().modelId ?? '--'}`}
									</text>
								</Show>
								<text fg={tactical.color.textDim} width={8} wrapMode="none">
									{String(session().turns)}
								</text>
								<text fg={tactical.color.textDim} width={10} wrapMode="none">
									{session().contextPercent === null ? '--' : `${session().contextPercent}%`}
								</text>
								<text fg={tactical.color.textDim} width={12} wrapMode="none">
									{relativeSessionTime(session().mtimeMs)}
								</text>
							</box>
						)}
					</Index>
					<box
						flexDirection="row"
						height={2}
						paddingLeft={1}
						alignItems="center"
						backgroundColor={
							selected() === props.sessions().length ? tactical.color.raised : tactical.color.panel
						}
					>
						<text fg={tactical.color.coreBright} width={2} wrapMode="none">
							{selected() === props.sessions().length ? '▸' : ' '}
						</text>
						<text fg={tactical.color.grid} wrapMode="none">
							＋ NEW SESSION · HERE
						</text>
						<text fg={tactical.color.textDim} wrapMode="none">
							{' — FIRST MESSAGE BECOMES THE TITLE'}
						</text>
					</box>
				</box>
				<box flexGrow={1} />
				<text fg={props.notice() === null ? tactical.color.textDim : tactical.color.alert} wrapMode="none">
					{props.opening() ? 'WORKING…' : (props.notice() ?? 'SELECT A SESSION OR START A NEW ONE')}
				</text>
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
				<KeyHint keyName="J/K" label="SELECT" />
				<KeyHint keyName="↵" label="OPEN" />
				<KeyHint keyName="X" label="DELETE" />
				<KeyHint keyName="^N" label="NEW" />
				<KeyHint keyName="^K" label="COMMANDS" />
				<KeyHint keyName="T" label="THEME" />
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
			<Show when={deleteTarget()}>
				<box
					position="absolute"
					top={8}
					left={modalLeft()}
					width={modalWidth()}
					height={5}
					zIndex={20}
					paddingX={2}
					flexDirection="column"
					justifyContent="center"
					border
					borderStyle="double"
					borderColor={tactical.color.alert}
					backgroundColor={tactical.color.raised}
				>
					<text fg={tactical.color.alert} attributes={TextAttributes.BOLD} wrapMode="none">
						CONFIRM DELETION? (Y/N)
					</text>
				</box>
			</Show>
			<Show when={paletteOpen()}>
				<CommandPalette commands={paletteCommands()} onClose={() => setPaletteOpen(false)} />
			</Show>
		</box>
	)
}
