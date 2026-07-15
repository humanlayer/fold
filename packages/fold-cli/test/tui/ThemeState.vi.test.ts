import { THEMES } from '@humanlayer/fold-tui-theme/themes'
import { describe, expect, it } from 'vitest'

import { setCurrentTheme, theme } from '../../src/tui/ThemeState'

describe('TUI theme state', () => {
	it('restores tactical after cycling through every theme', () => {
		const tactical = structuredClone(THEMES.tactical)

		for (const themeId of ['wintermute', 'neuromancer', 'redalert', 'covenant', 'rapture', 'tactical'] as const) {
			setCurrentTheme(themeId)
		}

		expect(theme).toEqual(tactical)
		expect(THEMES.tactical).toEqual(tactical)
	})

	it('provides the F glitch control for every theme', () => {
		for (const candidate of Object.values(THEMES)) expect(candidate.fx.glitch).toBeDefined()
	})
})
