import type { KeyEvent } from '@opentui/core'
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react'
import { useEffect, useMemo, useState } from 'react'

import { Detail } from './components/Detail'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { Insights } from './components/Insights'
import { ItemList } from './components/ItemList'
import type { Feed, ItemKind } from './github/types'
import { ALL_FX_ON, installPostFx, nextVignetteMode } from './hud/postfx'
import type { FxToggles } from './hud/postfx'
import { nextThemeId, THEMES, ThemeProvider } from './theme/index'
import type { ThemeId } from './theme/index'

const LIST_WIDTH = 40
const RAIL_WIDTH = 34
/** Below this, drop the rail; below `NARROW`, drop the rail and shrink the list. */
const WIDE = 118
const NARROW = 84

interface AppProps {
	readonly feed: Feed
	readonly initialTheme: ThemeId
}

export function App({ feed, initialTheme }: AppProps) {
	const renderer = useRenderer()
	const { width } = useTerminalDimensions()

	const [themeId, setThemeId] = useState<ThemeId>(initialTheme)
	const [toggles, setToggles] = useState<FxToggles>(ALL_FX_ON)
	const [kind, setKind] = useState<ItemKind>('pr')
	const [cursor, setCursor] = useState<Record<ItemKind, number>>({ pr: 0, issue: 0 })

	const theme = THEMES[themeId]
	const items = kind === 'pr' ? feed.pulls : feed.issues
	const selectedIndex = Math.min(cursor[kind], Math.max(0, items.length - 1))
	const selected = items[selectedIndex]

	const counts = useMemo<Record<ItemKind, number>>(
		() => ({ pr: feed.pulls.length, issue: feed.issues.length }),
		[feed],
	)

	// The post-process chain is derived from theme tokens, so it must be torn
	// down and rebuilt whenever the theme or the FX toggles change.
	useEffect(() => {
		renderer.setBackgroundColor(theme.color.void)
		return installPostFx(renderer, theme, toggles)
	}, [renderer, theme, toggles])

	useKeyboard((key: KeyEvent) => {
		if (key.eventType === 'release') return

		const move = (delta: number) => {
			setCursor((prev) => {
				const next = Math.max(0, Math.min(items.length - 1, prev[kind] + delta))
				return { ...prev, [kind]: next }
			})
		}

		switch (key.name) {
			case 'q':
			case 'escape':
				renderer.destroy()
				return
			case 'up':
			case 'k':
				return move(-1)
			case 'down':
			case 'j':
				return move(1)
			case 'pageup':
				return move(-8)
			case 'pagedown':
				return move(8)
			case 'tab':
				return setKind((prev) => (prev === 'pr' ? 'issue' : 'pr'))
			case 't':
				return setThemeId(nextThemeId)
			case 'b':
				return setToggles((prev) => ({ ...prev, glow: !prev.glow }))
			case 's':
				return setToggles((prev) => ({ ...prev, scanlines: !prev.scanlines }))
			case 'g':
				return setToggles((prev) => ({ ...prev, glitch: !prev.glitch }))
			case 'v':
				return setToggles((prev) => ({ ...prev, vignette: nextVignetteMode(prev.vignette) }))
			case 'r':
				// The scrolling CRT bar gets its own switch: it is the one pass that
				// never stops moving, so it is the one people want to turn off.
				return setToggles((prev) => ({ ...prev, rollingBar: !prev.rollingBar }))
		}

		// No FX toggle claims `c`, so Ctrl+C reaches this unconditionally and quitting
		// survives even if the renderer's `exitOnCtrlC` is ever removed.
		if (key.ctrl && key.name === 'c') renderer.destroy()
	})

	const showRail = width >= WIDE
	const listWidth = width >= NARROW ? LIST_WIDTH : Math.max(24, Math.floor(width * 0.4))

	return (
		<ThemeProvider value={theme}>
			<box flexDirection="column" width="100%" height="100%" backgroundColor={theme.color.void}>
				<Header feed={feed} />

				<box flexDirection="row" flexGrow={1}>
					<ItemList
						items={items}
						kind={kind}
						counts={counts}
						selectedIndex={selectedIndex}
						width={listWidth}
					/>
					<Detail item={selected} />
					{showRail && <Insights width={RAIL_WIDTH} items={items} feed={feed} />}
				</box>

				<Footer toggles={toggles} />
			</box>
		</ThemeProvider>
	)
}
