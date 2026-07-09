import { createContext, useContext } from 'react'

import { augmented } from './augmented'
import { tactical } from './tactical'
import type { Theme, ThemeId } from './types'

export * from './types'

export const THEMES: Readonly<Record<ThemeId, Theme>> = {
	augmented,
	tactical,
}

export function isThemeId(value: string): value is ThemeId {
	return value === 'augmented' || value === 'tactical'
}

export function nextThemeId(current: ThemeId): ThemeId {
	return current === 'augmented' ? 'tactical' : 'augmented'
}

const ThemeContext = createContext<Theme>(augmented)

export const ThemeProvider = ThemeContext.Provider

export function useTheme(): Theme {
	return useContext(ThemeContext)
}
