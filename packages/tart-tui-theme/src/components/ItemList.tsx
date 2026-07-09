import { TextAttributes } from '@opentui/core'
import type { ScrollBoxRenderable } from '@opentui/core'
import { useEffect, useRef } from 'react'

import { displayState } from '../github/types.ts'
import type { GhItem, ItemKind } from '../github/types.ts'
import { useTheme } from '../theme/index.ts'
import { clip, useStateStyle } from './atoms.tsx'

/** Reserved cells per row: gutter + glyph + space + `#nnnn` + space. */
const ROW_OVERHEAD = 10

function Row({ item, selected, width }: { item: GhItem; selected: boolean; width: number }) {
	const theme = useTheme()
	const { color } = theme
	const style = useStateStyle(displayState(item))

	return (
		<box
			id={`row-${item.kind}-${item.number}`}
			flexDirection="row"
			height={1}
			flexShrink={0}
			gap={1}
			paddingX={1}
			backgroundColor={selected ? color.raised : 'transparent'}
		>
			{/* Selection indicator: a laser-red caret, the only red in a calm list. */}
			<text fg={selected ? color.alert : 'transparent'} wrapMode="none">
				{selected ? '▸' : ' '}
			</text>
			<text fg={style.color} wrapMode="none">
				{style.glyph}
			</text>
			<text fg={selected ? color.coreBright : color.textDim} wrapMode="none">
				{`#${item.number}`.padEnd(5)}
			</text>
			<text
				fg={selected ? color.text : color.textDim}
				wrapMode="none"
				attributes={selected ? TextAttributes.BOLD : 0}
			>
				{clip(item.title, Math.max(4, width - ROW_OVERHEAD))}
			</text>
		</box>
	)
}

function Tab({ label, count, active }: { label: string; count: number; active: boolean }) {
	const theme = useTheme()
	const { color } = theme
	return (
		<text wrapMode="none" attributes={active ? TextAttributes.BOLD : TextAttributes.DIM}>
			<span fg={active ? color.coreBright : color.textFaint}>{` ${label} `}</span>
			<span fg={active ? color.inject : color.textFaint}>{`${count} `}</span>
		</text>
	)
}

export interface ItemListProps {
	readonly items: readonly GhItem[]
	readonly kind: ItemKind
	readonly counts: Readonly<Record<ItemKind, number>>
	readonly selectedIndex: number
	readonly width: number
}

export function ItemList({ items, kind, counts, selectedIndex, width }: ItemListProps) {
	const theme = useTheme()
	const { color, chrome } = theme
	const scrollRef = useRef<ScrollBoxRenderable>(null)
	const selected = items[selectedIndex]

	// Keep the cursor in view. Imperative sync with the renderer — the one
	// place an effect is the right tool.
	useEffect(() => {
		if (!selected) return
		scrollRef.current?.scrollChildIntoView(`row-${selected.kind}-${selected.number}`)
	}, [selected])

	return (
		<box
			width={width}
			flexShrink={0}
			flexDirection="column"
			border
			borderStyle={chrome.panelStyle}
			borderColor={chrome.border}
			title=" INDEX "
			titleColor={chrome.title}
			backgroundColor={color.panel}
		>
			<box flexDirection="row" height={1} flexShrink={0} paddingX={1}>
				<Tab label="PULLS" count={counts.pr} active={kind === 'pr'} />
				<Tab label="ISSUES" count={counts.issue} active={kind === 'issue'} />
			</box>

			<box height={1} flexShrink={0} border={['top']} borderStyle="single" borderColor={color.textFaint} />

			<scrollbox
				ref={scrollRef}
				flexGrow={1}
				scrollY
				scrollbarOptions={{
					showArrows: false,
					trackOptions: { backgroundColor: color.textFaint, foregroundColor: color.gridDim },
				}}
			>
				{items.length === 0 ? (
					<text fg={color.textFaint}>{'  NO RECORDS'}</text>
				) : (
					items.map((item, index) => (
						<Row
							key={`${item.kind}-${item.number}`}
							item={item}
							selected={index === selectedIndex}
							width={width}
						/>
					))
				)}
			</scrollbox>
		</box>
	)
}
