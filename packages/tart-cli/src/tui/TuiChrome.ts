import { theme } from './ThemeState'

export const TUI_CONTEXT_TITLE = ' CONTEXT '
export const TUI_LIVE_BADGE = 'LIVE'
export const TUI_INSPECT_BADGE = 'INSPECT'
export const TUI_FX_KEYS = ['B', 'S', 'G', 'V', 'R'] as const

export const tuiScrollbarOptions = () => ({
	showArrows: false,
	trackOptions: {
		backgroundColor: theme.color.textFaint,
		foregroundColor: theme.color.gridDim,
	},
})
