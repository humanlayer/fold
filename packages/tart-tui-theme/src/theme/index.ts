import { createContext, useContext } from 'react'

import { covenant } from './covenant'
import { neuromancer } from './neuromancer'
import { rapture } from './rapture'
import { redalert } from './redalert'
import { tactical } from './tactical'
import type { Theme, ThemeId } from './types'
import { wintermute } from './wintermute'

export * from './types'

/** The `t`-key cycle order: the two shipped themes first, then the experiments. */
export const THEME_ORDER = [
	'rapture',
	'tactical',
	'neuromancer',
	'redalert',
	'covenant',
	'wintermute',
] as const satisfies readonly ThemeId[]

export const THEMES: Readonly<Record<ThemeId, Theme>> = {
	rapture,
	tactical,
	neuromancer,
	redalert,
	covenant,
	wintermute,
}

export function isThemeId(value: string): value is ThemeId {
	return Object.hasOwn(THEMES, value)
}

export function nextThemeId(current: ThemeId): ThemeId {
	const index = THEME_ORDER.indexOf(current)
	return THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? 'tactical'
}

const ThemeContext = createContext<Theme>(tactical)

export const ThemeProvider = ThemeContext.Provider

export function useTheme(): Theme {
	return useContext(ThemeContext)
}
