import { useEffect, useState } from 'react'

import { useTheme } from '../theme/index.ts'

const BAR_WIDTH = 12

/** Escalation: calm amber -> injected -> critical. Exactly what red is for. */
function useBarColor(value: number): string {
	const { color } = useTheme()
	if (value > 0.85) return color.alert
	if (value > 0.65) return color.inject
	return color.core
}

function Bar({ label, value }: { label: string; value: number }) {
	const theme = useTheme()
	const { color } = theme
	const fill = useBarColor(value)

	const exact = Math.max(0, Math.min(1, value)) * BAR_WIDTH
	const whole = Math.floor(exact)
	const remainder = exact - whole

	const ramp = theme.barRamp
	const partialIndex = Math.min(ramp.length - 1, Math.floor(remainder * ramp.length))
	const partial = remainder > 0.05 && whole < BAR_WIDTH ? (ramp[partialIndex] ?? '') : ''

	const filled = '█'.repeat(whole) + partial
	const empty = '·'.repeat(Math.max(0, BAR_WIDTH - filled.length))

	return (
		<text wrapMode="none">
			<span fg={color.textFaint}>{label.padEnd(5)}</span>
			<span fg={fill}>{filled}</span>
			<span fg={color.textFaint}>{empty}</span>
			<span fg={color.textDim}>{` ${String(Math.round(value * 100)).padStart(3)}%`}</span>
		</text>
	)
}

interface Gauge {
	readonly label: string
	/** Radians/second. */
	readonly rate: number
	readonly phase: number
	readonly floor: number
	readonly span: number
}

const GAUGES: readonly Gauge[] = [
	{ label: 'CPU', rate: 0.7, phase: 0, floor: 0.35, span: 0.55 },
	{ label: 'MEM', rate: 0.31, phase: 1.7, floor: 0.5, span: 0.3 },
	{ label: 'NET', rate: 1.9, phase: 0.4, floor: 0.1, span: 0.85 },
	{ label: 'I/O', rate: 1.1, phase: 3.1, floor: 0.2, span: 0.6 },
]

export function Telemetry() {
	const [t, setT] = useState(0)

	// A 100ms tick is plenty for gauges — the reticle owns the frame budget.
	useEffect(() => {
		const handle = setInterval(() => setT((prev) => prev + 0.1), 100)
		return () => clearInterval(handle)
	}, [])

	return (
		<box flexDirection="column" flexShrink={0}>
			{GAUGES.map((gauge) => {
				const wave = 0.5 + 0.5 * Math.sin(t * gauge.rate + gauge.phase)
				return <Bar key={gauge.label} label={gauge.label} value={gauge.floor + wave * gauge.span} />
			})}
		</box>
	)
}
