import { displayState } from './types'
import type { DisplayState, GhItem } from './types'

/**
 * Aggregations over the loaded feed. Everything here is derived from records
 * GitHub actually returned — nothing is synthesized. If a panel can't be backed
 * by one of these, it doesn't belong on screen.
 */

interface Tally<T> {
	readonly key: T
	readonly count: number
}

/** Fixed order so the bars don't reshuffle when counts change. */
const STATE_ORDER: readonly DisplayState[] = ['open', 'draft', 'merged', 'closed']

export function stateTallies(items: readonly GhItem[]): Tally<DisplayState>[] {
	const counts = new Map<DisplayState, number>()
	for (const item of items) {
		const state = displayState(item)
		counts.set(state, (counts.get(state) ?? 0) + 1)
	}
	return STATE_ORDER.map((key) => ({ key, count: counts.get(key) ?? 0 }))
}

/** Most-applied labels, descending. Ties break alphabetically for stability. */
export function labelTallies(items: readonly GhItem[], limit: number): Tally<string>[] {
	const counts = new Map<string, number>()
	for (const item of items) {
		for (const label of item.labels) counts.set(label, (counts.get(label) ?? 0) + 1)
	}
	return [...counts.entries()]
		.map(([key, count]) => ({ key, count }))
		.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
		.slice(0, limit)
}

export function authorTallies(items: readonly GhItem[], limit: number): Tally<string>[] {
	const counts = new Map<string, number>()
	for (const item of items) counts.set(item.author, (counts.get(item.author) ?? 0) + 1)
	return [...counts.entries()]
		.map(([key, count]) => ({ key, count }))
		.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
		.slice(0, limit)
}

interface DayBucket {
	/** Days before today. `0` is today. */
	readonly daysAgo: number
	readonly count: number
}

const DAY_MS = 86_400_000

/**
 * How many records were last updated on each of the past `days` days, oldest
 * first. Buckets by local midnight so "today" means what the reader expects.
 */
export function updatesByDay(items: readonly GhItem[], days: number): DayBucket[] {
	const startOfToday = new Date()
	startOfToday.setHours(0, 0, 0, 0)
	const todayMs = startOfToday.getTime()

	const buckets = new Array<number>(days).fill(0)
	for (const item of items) {
		const updated = new Date(item.updatedAt).getTime()
		if (Number.isNaN(updated)) continue

		// Anything at or after today's midnight is "today". Otherwise round *up*:
		// a record touched yesterday at 23:00 is one day old, not zero.
		const elapsed = todayMs - updated
		const daysAgo = elapsed <= 0 ? 0 : Math.ceil(elapsed / DAY_MS)

		const index = days - 1 - daysAgo
		if (index >= 0) buckets[index] = (buckets[index] ?? 0) + 1
	}

	return buckets.map((count, index) => ({ daysAgo: days - 1 - index, count }))
}
