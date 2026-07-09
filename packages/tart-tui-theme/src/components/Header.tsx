import { TextAttributes } from '@opentui/core'
import { useEffect, useState } from 'react'

import type { Feed } from '../github/types.ts'
import { useTheme } from '../theme/index.ts'

function rateText(feed: Feed): string {
	if (feed.offlineReason) return 'OFFLINE'
	if (!feed.rateLimit) return 'UNKNOWN'
	return `${feed.rateLimit.remaining}/${feed.rateLimit.limit}`
}

/**
 * The "active process" spinner. It owns its own frame counter so its 120ms tick
 * re-renders only this one span — not the whole app tree — the same way
 * `Telemetry` isolates its own interval. Laser purple: the "injected" slot per
 * brief A.
 */
function Spinner() {
	const theme = useTheme()
	const [frame, setFrame] = useState(0)

	// A renderer-driving timer is one of the few legitimate uses of an effect.
	useEffect(() => {
		const handle = setInterval(() => setFrame((prev) => prev + 1), 120)
		return () => clearInterval(handle)
	}, [])

	const glyph = theme.spinner[frame % theme.spinner.length] ?? ''
	return <span fg={theme.color.inject}>{glyph}</span>
}

export function Header({ feed }: { feed: Feed }) {
	const theme = useTheme()
	const { color, chrome } = theme

	// Amber when comfortable, purple/yellow when draining, red when nearly spent.
	const remaining = feed.rateLimit?.remaining ?? Number.POSITIVE_INFINITY
	const rateColor = remaining < 10 ? color.alert : remaining < 100 ? color.inject : color.core

	return (
		<box
			flexDirection="row"
			height={5}
			paddingX={1}
			gap={3}
			alignItems="center"
			border={['bottom']}
			borderStyle={chrome.frameStyle}
			borderColor={chrome.border}
		>
			<ascii-font text="TART" font="tiny" color={color.core} />

			<box flexDirection="column" justifyContent="center">
				<text fg={color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
					{theme.name}
				</text>
				<text fg={color.textDim} wrapMode="none">
					{theme.tagline}
				</text>
			</box>

			<box flexGrow={1} justifyContent="center">
				<text wrapMode="none">
					<span fg={color.textFaint}>{'REPO// '}</span>
					<span fg={color.grid}>{feed.repo}</span>
				</text>
			</box>

			<box flexDirection="column" alignItems="flex-end" justifyContent="center">
				<text wrapMode="none">
					<Spinner />
					<span fg={color.textFaint}>{' AUTH '}</span>
					<span fg={feed.authenticated ? color.grid : color.textDim}>
						{feed.authenticated ? 'TOKEN' : 'ANON'}
					</span>
				</text>
				<text wrapMode="none">
					<span fg={color.textFaint}>{'RATE '}</span>
					<span fg={rateColor}>{rateText(feed)}</span>
				</text>
			</box>
		</box>
	)
}
