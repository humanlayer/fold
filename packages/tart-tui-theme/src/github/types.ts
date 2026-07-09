export type ItemKind = 'pr' | 'issue'

/** A normalized pull request or issue. */
export interface GhItem {
	readonly kind: ItemKind
	readonly number: number
	readonly title: string
	readonly state: 'open' | 'closed'
	readonly draft: boolean
	readonly merged: boolean
	readonly author: string
	readonly createdAt: string
	readonly updatedAt: string
	readonly comments: number
	readonly labels: readonly string[]
	readonly body: string
	readonly url: string
	readonly headRef?: string
	readonly baseRef?: string
}

export interface RateLimit {
	readonly limit: number
	readonly remaining: number
	readonly resetsAt: Date
	/**
	 * Preformatted "resets in …" string (e.g. `in 42m`), so the UI can print the
	 * reset countdown without doing `Date` math itself. Additive/optional: existing
	 * consumers that only read `remaining`/`limit` are unaffected.
	 */
	readonly resetsIn?: string
}

export interface Feed {
	readonly repo: string
	readonly pulls: readonly GhItem[]
	readonly issues: readonly GhItem[]
	readonly rateLimit: RateLimit | null
	/** Set when we fell back to bundled fixtures instead of hitting the network. */
	readonly offlineReason: string | null
	readonly authenticated: boolean
}

/** Derived display state — collapses `state`/`draft`/`merged` into one token. */
export type DisplayState = 'open' | 'closed' | 'merged' | 'draft'

export function displayState(item: GhItem): DisplayState {
	if (item.merged) return 'merged'
	if (item.draft && item.state === 'open') return 'draft'
	return item.state
}
