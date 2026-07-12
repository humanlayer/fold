import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'

import { App } from './App'
import { loadFeed } from './github/client'
import { isThemeId } from './theme/index'
import type { ThemeId } from './theme/index'

interface Args {
	readonly theme: ThemeId
	readonly owner: string
	readonly repo: string
	readonly demo: boolean
}

function parseArgs(argv: readonly string[]): Args {
	let theme: ThemeId = 'tactical'
	let slug = 'humanlayer/tart'
	let demo = false

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--demo') demo = true
		if (arg === '--theme') {
			const value = argv[i + 1]
			if (value && isThemeId(value)) theme = value
			i++
		}
		if (arg === '--repo') {
			const value = argv[i + 1]
			if (value) slug = value
			i++
		}
	}

	const [owner = 'humanlayer', repo = 'tart'] = slug.split('/')
	return { theme, owner, repo, demo }
}

const args = parseArgs(process.argv.slice(2))
const feed = await loadFeed(args)

const renderer = await createCliRenderer({
	// 30fps leaves budget for the post-process chain (the glow is the costly pass).
	targetFps: 30,
	exitOnCtrlC: true,
	// The console overlay would paint over the HUD, and it steals ctrl+k.
	consoleMode: 'disabled',
})

createRoot(renderer).render(<App feed={feed} initialTheme={args.theme} />)

// OpenTUI renders on demand: a frame is drawn only when a prop changes. Nothing in
// this app animates its *tree* — the motion lives entirely in the time-driven
// post-process passes (glitch bursts in both themes, the CRT rolling bar in
// tactical), which only advance on a rendered frame. Without an explicit loop those
// effects freeze after the first paint. Measured: 4 frames/1.2s off, ~30 on.
renderer.start()
