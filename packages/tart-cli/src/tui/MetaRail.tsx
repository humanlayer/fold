/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, Index, onCleanup, type JSX } from 'solid-js'

import { accent, accentPalette, accentTrack } from './AccentPalette'
import type { metaCounts } from './Subagents'
import { theme } from './ThemeState'

type Meta = ReturnType<typeof metaCounts>

const glyphForTool = (name: string): string => {
	if (name === 'bash') return '⚙'
	if (name === 'read') return '▤'
	if (name === 'edit') return '✎'
	if (name === 'write') return '✚'
	if (name === 'subagent') return '★'
	if (name === 'skill') return '✦'
	return '◆'
}

const colorForTool = (name: string): string => {
	if (name === 'bash') return accent.orange
	if (name === 'read') return accent.blue
	if (name === 'edit') return accent.green
	if (name === 'subagent') return accent.cyan
	if (name === 'write') return accent.purple
	if (name === 'skill') return accent.yellow
	const hash = [...name].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0)
	return accentPalette[hash % accentPalette.length]!
}

const agentTypeColor = (name: string): string => {
	const normalized = name.toLowerCase()
	if (normalized.includes('locator')) return accent.blue
	if (normalized.includes('analy')) return accent.cyan
	if (normalized.includes('implement')) return accent.green
	if (normalized.includes('research')) return accent.purple
	const hash = [...normalized].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0)
	return accentPalette[hash % accentPalette.length]!
}

const Panel = (props: { readonly title: string; readonly children: JSX.Element }) => (
	<box
		flexShrink={0}
		flexDirection="column"
		paddingX={1}
		border
		borderStyle={theme.chrome.panelStyle}
		borderColor={theme.chrome.border}
		title={` ${props.title} `}
		titleColor={theme.chrome.title}
		backgroundColor={theme.color.panel}
	>
		{props.children}
	</box>
)

const Bar = (props: { readonly value: number; readonly max: number; readonly color: string }) => {
	const width = 10
	const exact = props.max > 0 ? (props.value / props.max) * width : 0
	const whole = Math.floor(exact)
	const remainder = exact - whole
	const partialIndex = Math.min(theme.barRamp.length - 1, Math.floor(remainder * theme.barRamp.length))
	const partial = remainder > 0.05 && whole < width ? (theme.barRamp[partialIndex] ?? '') : ''
	const filled = '█'.repeat(whole) + partial
	return (
		<text wrapMode="none">
			<span style={{ fg: props.color }}>{filled}</span>
			<span style={{ fg: accentTrack }}>{'·'.repeat(Math.max(0, width - filled.length))}</span>
		</text>
	)
}

const MetricRow = (props: {
	readonly glyph?: string
	readonly label: string
	readonly count: number
	readonly max: number
	readonly color: string
}) => {
	const [displayedCount, setDisplayedCount] = createSignal(props.count)
	const [displayedMax, setDisplayedMax] = createSignal(props.max)
	let previousCount = props.count
	let previousMax = props.max
	let timer: ReturnType<typeof setInterval> | undefined

	createEffect(() => {
		const targetCount = props.count
		const targetMax = props.max
		if (targetCount === previousCount && targetMax === previousMax) return
		if (timer !== undefined) clearInterval(timer)

		const startCount = displayedCount()
		const startMax = displayedMax()
		const frames = 8
		let frame = 0
		timer = setInterval(() => {
			frame += 1
			const progress = 1 - Math.pow(1 - frame / frames, 3)
			setDisplayedCount(startCount + (targetCount - startCount) * progress)
			setDisplayedMax(startMax + (targetMax - startMax) * progress)
			if (frame >= frames) {
				clearInterval(timer)
				timer = undefined
				setDisplayedCount(targetCount)
				setDisplayedMax(targetMax)
			}
		}, 35)
		previousCount = targetCount
		previousMax = targetMax
	})
	onCleanup(() => {
		if (timer !== undefined) clearInterval(timer)
	})

	return (
		<box flexDirection="row" height={1} flexShrink={0} gap={1}>
			<text fg={props.color} width={2} wrapMode="none">
				{props.glyph ?? ''}
			</text>
			<text fg={props.color} width={12} wrapMode="none">
				{props.label.slice(0, 12)}
			</text>
			<Bar value={displayedCount()} max={displayedMax()} color={props.color} />
			<text fg={props.color} width={3} wrapMode="none">
				{String(Math.round(displayedCount())).padStart(3)}
			</text>
		</box>
	)
}

export const MetaRail = (props: { readonly meta: Meta }) => {
	const maxAgentType = () => Math.max(1, ...props.meta.agentTypes.map((item) => item[1]))
	const maxTool = () => Math.max(1, ...props.meta.toolCalls.map((item) => item[1]))
	return (
		<scrollbox flexGrow={1} scrollY>
			<Panel title="STATUS">
				<box flexDirection="row" height={1} gap={1}>
					<text fg={theme.color.textFaint} width={5} wrapMode="none">
						ACT
					</text>
					<text fg={theme.color.core} wrapMode="none">
						{props.meta.sparkline}
					</text>
					<box flexGrow={1} />
					<text fg={theme.color.text} wrapMode="none">{`${props.meta.tools} tools`}</text>
				</box>
				<box flexDirection="row" height={1} gap={1}>
					<text fg={theme.color.textFaint} width={5} wrapMode="none">
						CTX
					</text>
					<text fg={theme.color.grid} wrapMode="none">
						{props.meta.contextTokens === 0 ? '—' : `${props.meta.contextTokens} tok`}
					</text>
					<box flexGrow={1} />
					<text fg={theme.color.textFaint} wrapMode="none">
						latest
					</text>
				</box>
				<box flexDirection="row" height={1} gap={1}>
					<text fg={theme.color.textFaint} width={5} wrapMode="none">
						COST
					</text>
					<text fg={theme.color.textFaint} wrapMode="none">
						—
					</text>
					<box flexGrow={1} />
					<text
						fg={theme.color.text}
						wrapMode="none"
					>{`${props.meta.agents} agents · ${props.meta.turns} turns`}</text>
				</box>
				<box flexDirection="row" height={1} gap={1}>
					<text fg={theme.color.textFaint} width={5} wrapMode="none">
						RUN
					</text>
					<text wrapMode="none">
						<span style={{ fg: theme.color.core }}>● {props.meta.running} run </span>
						<span style={{ fg: theme.color.grid }}>◆ {props.meta.done} done </span>
						<span style={{ fg: theme.color.alert }}>✕ {props.meta.errors} err</span>
					</text>
				</box>
			</Panel>
			<Panel title="AGENT TYPES">
				<Index each={props.meta.agentTypes} fallback={<text fg={theme.color.textFaint}>NONE</text>}>
					{(item) => (
						<MetricRow
							label={item()[0]}
							count={item()[1]}
							max={maxAgentType()}
							color={agentTypeColor(item()[0])}
						/>
					)}
				</Index>
			</Panel>
			<Panel title={`TOOL CALLS  ${props.meta.tools}`}>
				<Index each={props.meta.toolCalls} fallback={<text fg={theme.color.textFaint}>NONE</text>}>
					{(item) => (
						<MetricRow
							glyph={glyphForTool(item()[0])}
							label={item()[0]}
							count={item()[1]}
							max={maxTool()}
							color={colorForTool(item()[0])}
						/>
					)}
				</Index>
			</Panel>
		</scrollbox>
	)
}
