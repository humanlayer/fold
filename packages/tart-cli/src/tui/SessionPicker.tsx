/** @jsxImportSource @opentui/solid */
import type { SessionSummary } from '@humanlayer/tart-agent'
import type { SessionId } from '@humanlayer/tart-core'
import { tactical } from '@humanlayer/tart-tui-theme/tactical'
import { TextAttributes, type KeyEvent } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/solid'
import { createEffect, createMemo, createSignal, Index, Show, type Accessor } from 'solid-js'

import { relativeSessionTime, shortSessionId } from './SessionPickerState'

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
}

export type SessionPickerRow = SessionSummary & { readonly contextPercent: number | null }

export const SessionPicker = (props: SessionPickerProps) => {
	const dimensions = useTerminalDimensions()
	const [selected, setSelected] = createSignal(0)
	const [deleteTarget, setDeleteTarget] = createSignal<SessionPickerRow | null>(null)
	const itemCount = createMemo(() => props.sessions().length + 1)
	const showModeProfile = createMemo(() => dimensions().width >= 105)
	const showProviderModel = createMemo(() => dimensions().width >= 130)
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

	useKeyboard((key: KeyEvent) => {
		if (key.eventType === 'release' || props.opening()) return
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
		</box>
	)
}
