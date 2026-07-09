/**
 * Render a single frame to plain text and print it.
 *
 * Lets you iterate on layout without a TTY, and diff the two themes:
 *
 *   bun run scripts/preview.tsx --theme tactical --size 140x44
 *   bun run scripts/preview.tsx --keys tab,j,j
 *   bun run scripts/preview.tsx --theme augmented --spans   # fg-color histogram
 *
 * `--keys` delivers a comma-separated key sequence, driving the app the same way
 * a user would. Two non-obvious things make this work:
 *
 *  1. We do NOT use `flush()` / `waitForVisualIdle()`. The reticle and data-stream
 *     renderables are `live: true`, which pins the renderer's live-count above
 *     zero (`requestLive()` -> `_isRunning = true`) and animates cells every
 *     frame, so "wait until idle" never satisfies either exit condition. It throws
 *     after 20 frames and the still-running live loop then keeps the process alive
 *     forever. `renderOnce()` runs one bounded pass and always returns.
 *
 *  2. `mockInput.pressKey` dispatches the key synchronously, but React (the
 *     OpenTUI reconciler) commits the resulting `setState` on a *macrotask* — its
 *     scheduler uses a timer. Microtasks and `process.nextTick` fire too early, so
 *     after each key we yield a real `setTimeout(0)` before drawing the frame.
 */
import { testRender } from '@opentui/react/test-utils'

import { App } from '../src/App.tsx'
import { DEMO_FEED } from '../src/github/fixtures.ts'
import '../src/hud/register.ts'
import { isThemeId } from '../src/theme/index.ts'
import type { ThemeId } from '../src/theme/index.ts'

const argv = process.argv.slice(2)

function flag(name: string): string | undefined {
	const index = argv.indexOf(`--${name}`)
	return index === -1 ? undefined : argv[index + 1]
}

function hasFlag(name: string): boolean {
	return argv.includes(`--${name}`)
}

const themeArg = flag('theme')
const theme: ThemeId = themeArg && isThemeId(themeArg) ? themeArg : 'augmented'

const [w = '140', h = '44'] = (flag('size') ?? '140x44').split('x')
const width = Number(w)
const height = Number(h)

const keys = (flag('keys') ?? '')
	.split(',')
	.map((key) => key.trim())
	.filter((key) => key.length > 0)

const showSpans = hasFlag('spans')

/**
 * `mockInput.pressKey` treats an unrecognized string as literal bytes, so
 * `pressKey("tab")` would type t, a, b. Map friendly names to the sequences the
 * stdin parser decodes into a single key. Single characters (`j`, `t`, `q`) pass
 * straight through.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
	tab: '\t',
	enter: '\r',
	return: '\r',
	esc: '\x1b',
	escape: '\x1b',
	space: ' ',
	up: '\x1b[A',
	down: '\x1b[B',
	right: '\x1b[C',
	left: '\x1b[D',
	pageup: '\x1b[5~',
	pagedown: '\x1b[6~',
	home: '\x1b[H',
	end: '\x1b[F',
	backspace: '\b',
	delete: '\x1b[3~',
}

function resolveKey(name: string): string {
	return KEY_ALIASES[name.toLowerCase()] ?? name
}

/**
 * Yield one real macrotask so React's scheduler flushes the commit queued by the
 * keyboard handler, then draw exactly one frame reflecting the new state.
 */
async function settleFrame(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0))
	await setup.renderOnce()
}

function toHex(color: { r: number; g: number; b: number }): string {
	const channel = (value: number): string => Math.round(value * 255).toString(16).padStart(2, '0')
	return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

/**
 * A histogram of distinct foreground colors and how many *visible* (non-space)
 * cells each paints. Blank cells carry a foreground too, but nothing is drawn in
 * it, so counting them would drown out actual palette usage — the whole point
 * being to answer "is red rare? does amber dominate?".
 */
function formatSpanHistogram(frame: ReturnType<typeof setup.captureSpans>): string {
	const counts = new Map<string, number>()
	for (const line of frame.lines) {
		for (const span of line.spans) {
			let visible = 0
			for (const char of span.text) {
				if (char !== ' ') visible += 1
			}
			if (visible === 0) continue
			const key = toHex(span.fg)
			counts.set(key, (counts.get(key) ?? 0) + visible)
		}
	}

	const rows = [...counts.entries()].sort((a, b) => b[1] - a[1])
	const total = rows.reduce((sum, [, count]) => sum + count, 0)
	const peak = rows[0]?.[1] ?? 0
	const barWidth = 32

	// Alpha-blended HUD overlays fragment each theme token into a long tail of
	// near-duplicate shades, so cap the print at the dominant colors and fold the
	// rest into one summary line. `--spans-top N` overrides the cap.
	const topArg = Number(flag('spans-top'))
	const limit = Number.isFinite(topArg) && topArg > 0 ? Math.floor(topArg) : 24
	const shown = rows.slice(0, limit)

	const bars = shown.map(([color, count]) => {
		const filled = peak > 0 ? Math.max(1, Math.round((count / peak) * barWidth)) : 0
		const share = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0'
		return `${color}  ${String(count).padStart(6)}  ${share.padStart(5)}%  ${'█'.repeat(filled)}`
	})

	const rest = rows.slice(limit)
	if (rest.length > 0) {
		const restCells = rest.reduce((sum, [, count]) => sum + count, 0)
		const restShare = total > 0 ? ((restCells / total) * 100).toFixed(1) : '0.0'
		bars.push(`… +${rest.length} more  ${String(restCells).padStart(6)}  ${restShare.padStart(5)}%`)
	}

	const header = `foreground colors: ${rows.length} distinct · ${total} visible cells · ${frame.cols}x${frame.rows}`
	return [header, ...bars].join('\n')
}

const setup = await testRender(<App feed={DEMO_FEED} initialTheme={theme} />, { width, height })

// The spinner/telemetry intervals fire outside `act()`. That is correct app
// behavior; only the test harness cares, so stop it from warning.
// @ts-expect-error test-only global installed by testRender
globalThis.IS_REACT_ACT_ENVIRONMENT = false

await setup.renderOnce()
for (const key of keys) {
	setup.mockInput.pressKey(resolveKey(key))
	await settleFrame()
}
await setup.renderOnce()

process.stdout.write(`${showSpans ? formatSpanHistogram(setup.captureSpans()) : setup.captureCharFrame()}\n`)
setup.renderer.destroy()
process.exit(0)
