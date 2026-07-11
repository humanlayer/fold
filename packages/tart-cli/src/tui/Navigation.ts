export type Pane = 'events' | 'context'

export type NavigationLevel = 'pane' | 'content' | 'input'

export type NavigationState = {
	readonly pane: Pane
	readonly level: NavigationLevel
	readonly selectedKey: string | null
}

export const initialNavigationState: NavigationState = {
	pane: 'events',
	level: 'pane',
	selectedKey: null,
}

export const selectedIndex = (keys: ReadonlyArray<string>, selectedKey: string | null): number => {
	if (keys.length === 0) return -1
	if (selectedKey === null) return keys.length - 1
	const index = keys.indexOf(selectedKey)
	return index === -1 ? keys.length - 1 : index
}

export const moveSelection = (state: NavigationState, keys: ReadonlyArray<string>, delta: -1 | 1): NavigationState => {
	if (keys.length === 0) return { ...state, selectedKey: null }
	const next = Math.max(0, Math.min(keys.length - 1, selectedIndex(keys, state.selectedKey) + delta))
	return { ...state, selectedKey: keys[next] ?? null }
}

export const jumpSelection = (
	state: NavigationState,
	keys: ReadonlyArray<string>,
	target: 'first' | 'last',
): NavigationState => ({
	...state,
	selectedKey: target === 'first' ? (keys[0] ?? null) : null,
})

export const reconcileSelection = (state: NavigationState, keys: ReadonlyArray<string>): NavigationState => {
	if (state.selectedKey === null || keys.includes(state.selectedKey)) return state
	return { ...state, selectedKey: null }
}

export const followLive = (state: NavigationState): NavigationState => ({ ...state, selectedKey: null })

export const contextMode = (state: NavigationState, keys: ReadonlyArray<string>): 'live' | 'inspect' => {
	if (state.selectedKey === null || state.selectedKey === keys[keys.length - 1]) return 'live'
	return 'inspect'
}
