import { THEMES, type Theme, type ThemeId } from '@humanlayer/tart-tui-theme/themes'
import { createMutable, modifyMutable, reconcile } from 'solid-js/store'

export const theme = createMutable<Theme>({ ...THEMES.tactical })

export const setCurrentTheme = (themeId: ThemeId): void => {
	modifyMutable(theme, reconcile(THEMES[themeId]))
}
