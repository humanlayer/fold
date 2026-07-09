import { createContext, useContext } from 'react'

import { augmented } from './augmented.ts'
import { tactical } from './tactical.ts'
import type { Theme, ThemeId } from './types.ts'

export * from './types.ts'
export { augmented, tactical }

export const THEMES: Readonly<Record<ThemeId, Theme>> = {
	augmented,
	tactical,
}

export const THEME_IDS: readonly ThemeId[] = ['augmented', 'tactical']

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
