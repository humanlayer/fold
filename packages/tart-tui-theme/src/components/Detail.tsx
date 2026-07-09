import { TextAttributes } from '@opentui/core'
import type { ReactNode } from 'react'

import { displayState } from '../github/types'
import type { GhItem } from '../github/types'
import { useTheme } from '../theme/index'
import { Chip, Field, Heading, relativeTime, Rule, useStateStyle } from './atoms'

/** `#123` cross-references and `inline code` get their own palette slots. */
const INLINE = /(`[^`]+`|#\d+)/g

function Inline({ text }: { text: string }) {
	const theme = useTheme()
	const { color } = theme
	const parts = text.split(INLINE).filter((part) => part.length > 0)

	return (
		<text wrapMode="word" fg={color.text}>
			{parts.map((part, index) => {
				if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
					// Structural data reads teal.
					return (
						<span key={index} fg={color.grid}>
							{part.slice(1, -1)}
						</span>
					)
				}
				if (/^#\d+$/.test(part)) {
					// A reference into another record: an injected process.
					return (
						<span key={index} fg={color.inject}>
							{part}
						</span>
					)
				}
				return (
					<span key={index} fg={color.text}>
						{part}
					</span>
				)
			})}
		</text>
	)
}

function BodyLine({ line }: { line: string }) {
	const theme = useTheme()
	const { color } = theme

	if (line.trim().length === 0) return <text> </text>

	if (line.startsWith('## ')) {
		return (
			<text fg={color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
				{`${theme.chrome.heading}${line.slice(3).toUpperCase()}`}
			</text>
		)
	}

	if (line.startsWith('# ')) {
		return (
			<text fg={color.core} attributes={TextAttributes.BOLD | TextAttributes.UNDERLINE} wrapMode="none">
				{line.slice(2).toUpperCase()}
			</text>
		)
	}

	const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
	if (bullet?.[1] !== undefined) {
		return (
			<box flexDirection="row" flexShrink={0}>
				<text fg={color.inject} wrapMode="none">
					{'  ▪ '}
				</text>
				<box flexGrow={1}>
					<Inline text={bullet[1]} />
				</box>
			</box>
		)
	}

	return <Inline text={line} />
}

function Meta({ item }: { item: GhItem }) {
	const theme = useTheme()
	const { color } = theme
	const style = useStateStyle(displayState(item))

	const rows: ReactNode[] = [
		<Field key="author" label="AUTHOR" value={item.author} color={color.core} />,
		<Field key="opened" label="OPENED" value={relativeTime(item.createdAt)} color={color.textDim} />,
		<Field key="updated" label="UPDATED" value={relativeTime(item.updatedAt)} color={color.textDim} />,
		<Field key="comments" label="COMMENTS" value={String(item.comments)} color={color.textDim} />,
	]

	if (item.headRef && item.baseRef) {
		rows.push(
			<text key="branch" wrapMode="none">
				<span fg={color.textFaint}>{'BRANCH'.padEnd(9)}</span>
				<span fg={color.grid}>{item.headRef}</span>
				<span fg={color.alert}>{' ──▶ '}</span>
				<span fg={color.grid}>{item.baseRef}</span>
			</text>,
		)
	}

	return (
		<box flexDirection="row" flexShrink={0} gap={3}>
			<box flexDirection="column" flexGrow={1}>
				{rows}
			</box>
			<box flexDirection="column" alignItems="flex-end" flexShrink={0}>
				<Chip label={style.label} color={style.color} />
				<text fg={color.textFaint} wrapMode="none">
					{item.kind === 'pr' ? 'PULL REQUEST' : 'ISSUE'}
				</text>
			</box>
		</box>
	)
}

export function Detail({ item }: { item: GhItem | undefined }) {
	const theme = useTheme()
	const { color, chrome } = theme
	// Hooks must run unconditionally, so resolve the style before any early return.
	const style = useStateStyle(item ? displayState(item) : 'open')

	if (!item) {
		return (
			<box
				flexGrow={1}
				border
				borderStyle={chrome.panelStyle}
				borderColor={chrome.border}
				title=" RECORD "
				titleColor={chrome.title}
				justifyContent="center"
				alignItems="center"
			>
				<text fg={color.textFaint}>{'NO RECORD SELECTED'}</text>
			</box>
		)
	}

	// Body text is user content, rendered verbatim. An *absent* body is chrome, so
	// its placeholder follows the chrome idiom: ALL CAPS and faint, like the
	// `NO RECORD SELECTED` / `NO RECORDS` empty states.
	const bodyLines = item.body.length > 0 ? item.body.split('\n') : null

	return (
		<box
			flexGrow={1}
			flexDirection="column"
			border
			borderStyle={chrome.panelStyle}
			borderColor={chrome.border}
			title={` RECORD ${String(item.number).padStart(4, '0')} `}
			titleColor={chrome.title}
			bottomTitle={` ${item.url} `}
			bottomTitleAlignment="right"
			backgroundColor={color.panel}
			paddingX={2}
			paddingY={1}
			gap={1}
		>
			<box flexDirection="row" flexShrink={0} gap={1}>
				<text fg={style.color} wrapMode="none">
					{style.glyph}
				</text>
				<box flexGrow={1}>
					<text fg={color.coreBright} attributes={TextAttributes.BOLD} wrapMode="word">
						{item.title}
					</text>
				</box>
			</box>

			<Meta item={item} />

			{item.labels.length > 0 && (
				<box flexDirection="row" flexShrink={0} gap={1} flexWrap="wrap">
					{item.labels.map((label) => (
						<Chip key={label} label={label} color={color.gridDim} />
					))}
				</box>
			)}

			<Rule />
			<Heading>description</Heading>

			<scrollbox
				flexGrow={1}
				scrollY
				scrollbarOptions={{
					showArrows: false,
					trackOptions: { backgroundColor: color.textFaint, foregroundColor: color.gridDim },
				}}
			>
				{bodyLines ? (
					bodyLines.map((line, index) => <BodyLine key={index} line={line} />)
				) : (
					<text fg={color.textFaint}>{'(NO DESCRIPTION PROVIDED)'}</text>
				)}
			</scrollbox>
		</box>
	)
}
