import { nextVignetteMode, vignetteStrength } from '@humanlayer/tart-tui-theme/postfx'
import { expect, it } from 'vitest'

import { TUI_CONTEXT_TITLE, TUI_FX_KEYS, TUI_LIVE_BADGE } from '../src/tui/TuiChrome'

it('exposes a TACTICAL live context shell with all five FX', () => {
	expect(TUI_CONTEXT_TITLE).toBe(' CONTEXT ')
	expect(TUI_LIVE_BADGE).toBe('LIVE')
	expect(TUI_FX_KEYS).toEqual(['B', 'S', 'G', 'V', 'R'])
})

it('cycles vignette off, light, and heavy with light at half strength', () => {
	expect(nextVignetteMode('heavy')).toBe('off')
	expect(nextVignetteMode('off')).toBe('light')
	expect(nextVignetteMode('light')).toBe('heavy')
	expect(vignetteStrength(0.7, 'off')).toBe(0)
	expect(vignetteStrength(0.7, 'light')).toBe(0.35)
	expect(vignetteStrength(0.7, 'heavy')).toBe(0.7)
})
