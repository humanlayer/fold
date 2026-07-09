import { TextAttributes } from '@opentui/core'

import type { DisplayState } from '../github/types.ts'
import { useTheme } from '../theme/index.ts'

/** Truncate to `width` cells, with an ellipsis when clipped. */
export function clip(text: string, width: number): string {
	if (width <= 0) return ''
	const flat = text.replace(/\s+/g, ' ').trim()
	if (flat.length <= width) return flat
	if (width <= 1) return '…'
	return `${flat.slice(0, width - 1)}…`
}

export function relativeTime(iso: string): string {
	if (!iso) return '—'
	const then = new Date(iso).getTime()
	if (Number.isNaN(then)) return '—'

	const seconds = Math.max(0, (Date.now() - then) / 1000)
	if (seconds < 3600) return `${Math.floor(seconds / 60)}M AGO`
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}H AGO`
	if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}D AGO`
	return `${Math.floor(seconds / 2_592_000)}MO AGO`
}

/** Glyph + palette slot for each GitHub state. */
export function useStateStyle(state: DisplayState): { glyph: string; color: string; label: string } {
	const theme = useTheme()
	switch (state) {
		case 'open':
			return { glyph: '◇', color: theme.semantic.open, label: 'OPEN' }
		case 'merged':
			return { glyph: '◆', color: theme.semantic.merged, label: 'MERGED' }
		case 'closed':
			return { glyph: '✕', color: theme.semantic.closed, label: 'CLOSED' }
		case 'draft':
			return { glyph: '◌', color: theme.semantic.draft, label: 'DRAFT' }
	}
}

/** A section heading, stamped with the theme's heading prefix. */
export function Heading({ children, color }: { children: string; color?: string }) {
	const theme = useTheme()
	return (
		<text fg={color ?? theme.color.coreDim} attributes={TextAttributes.BOLD}>
			{`${theme.chrome.heading}${children.toUpperCase()}`}
		</text>
	)
}

/** A full-width horizontal rule. Drawn as a 1-row box with only a top border. */
export function Rule({ color }: { color?: string }) {
	const theme = useTheme()
	return (
		<box
			height={1}
			border={['top']}
			borderStyle={theme.chrome.panelStyle}
			borderColor={color ?? theme.color.textFaint}
		/>
	)
}

/** `[ label ]` in a palette slot. */
export function Chip({ label, color }: { label: string; color: string }) {
	const theme = useTheme()
	return (
		<text wrapMode="none">
			<span fg={theme.color.textFaint}>[</span>
			<span fg={color}>{` ${label.toUpperCase()} `}</span>
			<span fg={theme.color.textFaint}>]</span>
		</text>
	)
}

/** `KEY  label` — bright key, dim description. */
export function KeyHint({ keyName, label }: { keyName: string; label: string }) {
	const theme = useTheme()
	return (
		<text wrapMode="none">
			<span fg={theme.color.coreBright}>{keyName}</span>
			<span fg={theme.color.textFaint}>{` ${label}`}</span>
		</text>
	)
}

/** `LABEL  value` — a dim key with a bright value, for readout rows. */
export function Field({ label, value, color }: { label: string; value: string; color?: string }) {
	const theme = useTheme()
	return (
		<text wrapMode="none">
			<span fg={theme.color.textFaint}>{`${label.padEnd(9)}`}</span>
			<span fg={color ?? theme.color.text}>{value}</span>
		</text>
	)
}
