import { describe, expect, it } from 'vitest'

import { requestToLaunchOptions } from '../../src/tui/LaunchRequests'
import {
	advanceModelPicker,
	initialModelPickerState,
	modelPickerChoices,
	retreatModelPicker,
	type ModelPickerState,
} from '../../src/tui/ModelSelectionState'

const configuration = {
	profiles: [{ name: 'pinned', mode: 'rlm' as const }],
	providers: [
		{
			name: 'claude-alias',
			kind: 'anthropic' as const,
			apiKeyEnv: null,
			credentialPresent: true,
			models: ['one', 'two'],
		},
	],
}

describe('new-session launch requests', () => {
	it('keeps profile and direct selections exclusive and never leaks process selection', () => {
		const processOptions = {
			cwd: '/old',
			profile: 'process-profile',
			mode: 'rlm',
			modelSelection: { provider: 'old', model: 'old' },
		} as const
		const profile = requestToLaunchOptions(processOptions, { cwd: '/new', _tag: 'profile', profile: 'pinned' })
		const direct = requestToLaunchOptions(processOptions, {
			cwd: '/other',
			_tag: 'direct',
			provider: 'claude-alias',
			model: 'one',
			mode: 'default',
		})

		expect(profile).toMatchObject({ cwd: '/new', profile: 'pinned' })
		expect(profile).not.toHaveProperty('mode')
		expect(profile).not.toHaveProperty('modelSelection')
		expect(direct).toMatchObject({
			cwd: '/other',
			mode: 'default',
			modelSelection: { provider: 'claude-alias', model: 'one' },
		})
		expect(direct).not.toHaveProperty('profile')
		expect(
			requestToLaunchOptions(processOptions, { cwd: '/default', _tag: 'profile', profile: 'default' }),
		).not.toHaveProperty('profile')
	})
})

describe('model picker state machine', () => {
	it('stages profile selection without a mode', () => {
		const profileStage = advanceModelPicker(initialModelPickerState(), 'profile', 'new-session') as ModelPickerState
		expect(modelPickerChoices(configuration, profileStage)[0]?.detail).toContain('profile-pinned rlm')
		expect(advanceModelPicker(profileStage, 'pinned', 'new-session')).toEqual({
			_tag: 'profile',
			profile: 'pinned',
		})
	})

	it('asks for mode only for a new direct session and supports stepwise escape', () => {
		const provider = advanceModelPicker(initialModelPickerState(), 'direct', 'new-session') as ModelPickerState
		const model = advanceModelPicker(provider, 'claude-alias', 'new-session') as ModelPickerState
		const mode = advanceModelPicker(model, 'two', 'new-session') as ModelPickerState

		expect(mode).toEqual({ _tag: 'mode', provider: 'claude-alias', model: 'two' })
		expect(advanceModelPicker(mode, 'rlm', 'new-session')).toEqual({
			_tag: 'direct',
			provider: 'claude-alias',
			model: 'two',
			mode: 'rlm',
		})
		expect(retreatModelPicker(mode)).toEqual({ _tag: 'model', provider: 'claude-alias' })
		expect(retreatModelPicker({ _tag: 'provider' })).toEqual({ _tag: 'kind' })
		expect(retreatModelPicker({ _tag: 'kind' })).toBeNull()
	})

	it('finishes active direct selection at model without claiming a mode', () => {
		const model = { _tag: 'model' as const, provider: 'claude-alias' }
		expect(advanceModelPicker(model, 'one', 'active')).toEqual({
			_tag: 'direct',
			provider: 'claude-alias',
			model: 'one',
		})
	})
})
