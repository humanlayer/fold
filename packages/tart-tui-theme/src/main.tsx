import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'

import { App } from './App.tsx'
import { loadFeed } from './github/client.ts'
import './hud/register.ts'
import { isThemeId } from './theme/index.ts'
import type { ThemeId } from './theme/index.ts'

interface Args {
	readonly theme: ThemeId
	readonly owner: string
	readonly repo: string
	readonly demo: boolean
}

function parseArgs(argv: readonly string[]): Args {
	let theme: ThemeId = 'augmented'
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
	// The reticle, grid, and data stream are all `live`, so the renderer loops
	// continuously rather than rendering on demand. 30fps leaves budget for the
	// post-process chain (bloom is the expensive pass).
	targetFps: 30,
	exitOnCtrlC: true,
	// The console overlay would paint over the HUD, and it steals ctrl+k.
	consoleMode: 'disabled',
})

createRoot(renderer).render(<App feed={feed} initialTheme={args.theme} />)
