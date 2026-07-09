import { useMemo } from 'react'
import type { ReactNode } from 'react'

import { authorTallies, labelTallies, stateTallies, updatesByDay } from '../github/stats'
import type { DisplayState, Feed, GhItem } from '../github/types'
import { useTheme } from '../theme/index'
import { useStateStyle } from './atoms'

const BAR_WIDTH = 10
const ACTIVITY_DAYS = 14
const TOP_LABELS = 5
const TOP_AUTHORS = 4

/** A horizontal bar with sub-cell precision, drawn from the theme's ramp. */
function Bar({ value, max, color, width = BAR_WIDTH }: { value: number; max: number; color: string; width?: number }) {
	const theme = useTheme()
	const ramp = theme.barRamp

	const exact = max > 0 ? (Math.max(0, value) / max) * width : 0
	const whole = Math.floor(exact)
	const remainder = exact - whole
	const partialIndex = Math.min(ramp.length - 1, Math.floor(remainder * ramp.length))
	const partial = remainder > 0.05 && whole < width ? (ramp[partialIndex] ?? '') : ''

	const filled = '█'.repeat(whole) + partial
	return (
		<text wrapMode="none">
			<span fg={color}>{filled}</span>
			<span fg={theme.color.textFaint}>{'·'.repeat(Math.max(0, width - filled.length))}</span>
		</text>
	)
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
	const { color, chrome } = useTheme()
	return (
		<box
			flexShrink={0}
			flexDirection="column"
			paddingX={1}
			border
			borderStyle={chrome.panelStyle}
			borderColor={chrome.border}
			title={` ${title} `}
			titleColor={chrome.title}
			backgroundColor={color.panel}
		>
			{children}
		</box>
	)
}

/** Counts per PR/issue state, colored by the same semantic slots the list uses. */
function StateBreakdown({ items }: { items: readonly GhItem[] }) {
	const tallies = useMemo(() => stateTallies(items), [items])
	const max = Math.max(1, ...tallies.map((t) => t.count))

	return (
		<Panel title="STATE">
			{tallies.map((tally) => (
				<StateRow key={tally.key} state={tally.key} count={tally.count} max={max} />
			))}
		</Panel>
	)
}

function StateRow({ state, count, max }: { state: DisplayState; count: number; max: number }) {
	const { color } = useTheme()
	const style = useStateStyle(state)
	const muted = count === 0

	return (
		<box flexDirection="row" height={1} flexShrink={0} gap={1}>
			<text fg={muted ? color.textFaint : style.color} wrapMode="none">
				{style.glyph}
			</text>
			<text fg={muted ? color.textFaint : color.textDim} wrapMode="none">
				{style.label.padEnd(7)}
			</text>
			<Bar value={count} max={max} color={muted ? color.textFaint : style.color} />
			<text fg={muted ? color.textFaint : color.text} wrapMode="none">
				{String(count).padStart(3)}
			</text>
		</box>
	)
}

function Labels({ items }: { items: readonly GhItem[] }) {
	const { color } = useTheme()
	const tallies = useMemo(() => labelTallies(items, TOP_LABELS), [items])
	const max = Math.max(1, ...tallies.map((t) => t.count))

	return (
		<Panel title="LABELS">
			{tallies.length === 0 ? (
				<text fg={color.textFaint}>{'NONE APPLIED'}</text>
			) : (
				tallies.map((tally) => (
					<box key={tally.key} flexDirection="row" height={1} flexShrink={0} gap={1}>
						<box flexGrow={1}>
							<text fg={color.grid} wrapMode="none" truncate>
								{tally.key.toUpperCase()}
							</text>
						</box>
						<Bar value={tally.count} max={max} color={color.gridDim} width={6} />
						<text fg={color.textDim} wrapMode="none">
							{String(tally.count).padStart(2)}
						</text>
					</box>
				))
			)}
		</Panel>
	)
}

function Authors({ items }: { items: readonly GhItem[] }) {
	const { color } = useTheme()
	const tallies = useMemo(() => authorTallies(items, TOP_AUTHORS), [items])
	const max = Math.max(1, ...tallies.map((t) => t.count))

	return (
		<Panel title="AUTHORS">
			{tallies.length === 0 ? (
				<text fg={color.textFaint}>{'NO RECORDS'}</text>
			) : (
				tallies.map((tally) => (
					<box key={tally.key} flexDirection="row" height={1} flexShrink={0} gap={1}>
						<box flexGrow={1}>
							<text fg={color.text} wrapMode="none" truncate>
								{tally.key}
							</text>
						</box>
						<Bar value={tally.count} max={max} color={color.core} width={6} />
						<text fg={color.textDim} wrapMode="none">
							{String(tally.count).padStart(2)}
						</text>
					</box>
				))
			)}
		</Panel>
	)
}

/** A sparkline of how many records were last touched on each of the past N days. */
function Activity({ items }: { items: readonly GhItem[] }) {
	const theme = useTheme()
	const { color } = theme
	const buckets = useMemo(() => updatesByDay(items, ACTIVITY_DAYS), [items])
	const max = Math.max(...buckets.map((b) => b.count))
	const total = buckets.reduce((sum, b) => sum + b.count, 0)

	const ramp = theme.sparkRamp
	const spark = buckets.map((bucket) => {
		if (bucket.count === 0) return ' '
		const step = Math.round((bucket.count / Math.max(1, max)) * (ramp.length - 1))
		return ramp[step] ?? ramp[0] ?? ' '
	})

	return (
		<Panel title="ACTIVITY">
			<text fg={color.core} wrapMode="none">
				{spark.join('')}
			</text>
			<text fg={color.textFaint} wrapMode="none">
				{`${ACTIVITY_DAYS}D`.padEnd(Math.max(1, ACTIVITY_DAYS - 5)) + 'TODAY'}
			</text>
			<text wrapMode="none">
				<span fg={color.textFaint}>{'UPDATED  '}</span>
				<span fg={color.text}>{String(total).padStart(3)}</span>
				<span fg={color.textFaint}>{'  PEAK '}</span>
				<span fg={max > 0 ? color.inject : color.textFaint}>{String(max).padStart(2)}</span>
			</text>
		</Panel>
	)
}

/**
 * Where the records came from. `offlineReason` and the rate-limit reset are the
 * only feed fields nothing else surfaces, and both matter when a panel looks wrong.
 */
function Source({ feed }: { feed: Feed }) {
	const { color } = useTheme()
	const reason = feed.offlineReason
	const live = reason === null

	// `DEMO_FEED` labels itself `"fixtures"`, which would just restate the line
	// above. A real fallback carries a reason worth reading (a 404, a rate limit).
	const detail = !live && reason !== 'fixtures' ? reason : null

	return (
		<Panel title="SOURCE">
			<text wrapMode="none">
				<span fg={color.textFaint}>{'FEED    '}</span>
				{/* Not `alert`: falling back to fixtures is a caveat, not a failure, and red stays rare. */}
				<span fg={live ? color.grid : color.inject}>{live ? 'LIVE' : 'FIXTURES'}</span>
			</text>

			{live && (
				<text wrapMode="none">
					<span fg={color.textFaint}>{'RESETS  '}</span>
					<span fg={color.text}>{feed.rateLimit?.resetsIn ?? 'UNKNOWN'}</span>
				</text>
			)}

			{detail !== null && (
				<box flexShrink={0} flexDirection="row">
					<text fg={color.textFaint} wrapMode="none">
						{'WHY     '}
					</text>
					<box flexGrow={1}>
						<text fg={color.textDim} wrapMode="word">
							{detail.toUpperCase()}
						</text>
					</box>
				</box>
			)}
		</Panel>
	)
}

/**
 * The right-hand rail. Every panel is an aggregation over the records that were
 * actually fetched — no synthesized gauges, no decorative readouts.
 */
export function Insights({ width, items, feed }: { width: number; items: readonly GhItem[]; feed: Feed }) {
	return (
		<box width={width} flexShrink={0} flexDirection="column">
			<StateBreakdown items={items} />
			<Labels items={items} />
			<Authors items={items} />
			<Activity items={items} />
			<Source feed={feed} />
		</box>
	)
}
