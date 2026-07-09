export type AnsiPalette = {
	readonly bold: (text: string) => string
	readonly dim: (text: string) => string
	readonly cyan: (text: string) => string
	readonly green: (text: string) => string
	readonly yellow: (text: string) => string
	readonly red: (text: string) => string
	readonly magenta: (text: string) => string
}

const wrap =
	(enabled: boolean, open: string, close: string) =>
	(text: string): string =>
		enabled ? `${open}${text}${close}` : text

/** ANSI color helpers used by the headless renderer. */
export const makeAnsiPalette = (enabled: boolean): AnsiPalette => ({
	bold: wrap(enabled, '\u001b[1m', '\u001b[22m'),
	dim: wrap(enabled, '\u001b[2m', '\u001b[22m'),
	cyan: wrap(enabled, '\u001b[36m', '\u001b[39m'),
	green: wrap(enabled, '\u001b[32m', '\u001b[39m'),
	yellow: wrap(enabled, '\u001b[33m', '\u001b[39m'),
	red: wrap(enabled, '\u001b[31m', '\u001b[39m'),
	magenta: wrap(enabled, '\u001b[35m', '\u001b[39m'),
})
