/**
 * Render the reticle in isolation, at a size you choose, for tuning ring
 * geometry:
 *
 *   bun run scripts/reticle.tsx --theme augmented --size 60x30
 */
import { testRender } from '@opentui/react/test-utils'

import '../src/hud/register.ts'
import { isThemeId, THEMES } from '../src/theme/index.ts'
import type { ThemeId } from '../src/theme/index.ts'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
	const index = argv.indexOf(`--${name}`)
	return index === -1 ? undefined : argv[index + 1]
}

const themeArg = flag('theme')
const themeId: ThemeId = themeArg && isThemeId(themeArg) ? themeArg : 'augmented'
const theme = THEMES[themeId]

const [w = '60', h = '30'] = (flag('size') ?? '60x30').split('x')

const setup = await testRender(<reticle spec={theme.reticle} width="100%" height="100%" />, {
	width: Number(w),
	height: Number(h),
})

// The reticle is `live: true`; its render loop drives updates outside React's
// act(). Mirror preview.tsx and drop the harness's act() global so those updates
// don't spam warnings.
// @ts-expect-error test-only global installed by testRender
globalThis.IS_REACT_ACT_ENVIRONMENT = false

await setup.renderOnce()
process.stdout.write(`${setup.captureCharFrame()}\n`)
setup.renderer.destroy()
process.exit(0)
