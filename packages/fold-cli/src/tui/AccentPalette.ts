export const accent = {
	green: '#22c55e',
	blue: '#2563eb',
	cyan: '#14b8a6',
	yellow: '#facc15',
	red: '#ef4444',
	purple: '#a855f7',
	orange: '#f59e0b',
} as const

export const accentPalette: ReadonlyArray<string> = [
	accent.green,
	accent.blue,
	accent.cyan,
	accent.yellow,
	accent.purple,
	accent.orange,
]

export const accentTrack = '#3f3f46'

export const agentTypeAccent = (name: string): string => {
	const normalized = name.toLowerCase()
	if (normalized.includes('locator')) return accent.blue
	if (normalized.includes('analy')) return accent.cyan
	if (normalized.includes('implement')) return accent.green
	if (normalized.includes('research')) return accent.purple
	if (normalized.includes('review')) return accent.yellow
	if (normalized.includes('web')) return accent.orange
	const hash = Array.from(normalized).reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0)
	return accentPalette[hash % accentPalette.length] ?? accent.cyan
}
