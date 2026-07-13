import { THEMES, type Theme, type ThemeId } from '@humanlayer/tart-tui-theme/themes'
import { createMutable, modifyMutable, reconcile } from 'solid-js/store'

const cloneTheme = (theme: Theme): Theme => structuredClone(theme)

export const theme = createMutable<Theme>(cloneTheme(THEMES.tactical))

export const setCurrentTheme = (themeId: ThemeId): void => {
	modifyMutable(theme, reconcile(cloneTheme(THEMES[themeId])))
}
