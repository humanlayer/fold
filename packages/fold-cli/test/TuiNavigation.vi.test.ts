import { describe, expect, it } from 'vitest'

import {
	contextMode,
	followLive,
	initialNavigationState,
	jumpSelection,
	moveSelection,
	reconcileSelection,
} from '../src/tui/Navigation'

describe('TUI navigation', () => {
	it('starts at the live tail and moves through stable row keys', () => {
		const keys = ['first', 'middle', 'last']
		const previous = moveSelection(initialNavigationState, keys, -1)

		expect(previous.selectedKey).toBe('middle')
		expect(contextMode(previous, keys)).toBe('inspect')
		expect(moveSelection(previous, keys, 1).selectedKey).toBe('last')
	})

	it('supports top and live-tail jumps', () => {
		const keys = ['first', 'last']
		const first = jumpSelection(initialNavigationState, keys, 'first')

		expect(first.selectedKey).toBe('first')
		expect(contextMode(first, keys)).toBe('inspect')
		expect(jumpSelection(first, keys, 'last').selectedKey).toBeNull()
	})

	it('returns to live when a selected transient row disappears', () => {
		const state = { ...initialNavigationState, selectedKey: 'gone' }
		expect(reconcileSelection(state, ['other']).selectedKey).toBeNull()
	})

	it('returns to live after sending from an inspected event', () => {
		const inspecting = { ...initialNavigationState, level: 'input' as const, selectedKey: 'historical' }
		const following = followLive(inspecting)

		expect(following).toEqual({ ...inspecting, selectedKey: null })
		expect(contextMode(following, ['historical', 'latest'])).toBe('live')
	})
})
