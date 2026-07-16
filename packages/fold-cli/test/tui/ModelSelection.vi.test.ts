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

const requirePickerState = (state: ReturnType<typeof advanceModelPicker>): ModelPickerState => {
	if (state === null) throw new Error('Expected model picker to advance')
	if (state._tag === 'direct' || (state._tag === 'profile' && 'profile' in state))
		throw new Error('Expected an intermediate model picker state')
	return state
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
	it('defaults direct selection to Codex Sol when configured', () => {
		const configured = {
			...configuration,
			providers: [
				...configuration.providers,
				{
					name: 'codex',
					kind: 'codex' as const,
					apiKeyEnv: null,
					credentialPresent: true,
					models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
				},
			],
		}

		expect(modelPickerChoices(configured, initialModelPickerState())[0]?.id).toBe('direct')
		expect(modelPickerChoices(configured, { _tag: 'provider' })[0]?.id).toBe('codex')
		expect(modelPickerChoices(configured, { _tag: 'model', provider: 'codex' })[0]?.id).toBe('gpt-5.6-sol')
	})

	it('stages profile selection without a mode', () => {
		const profileStage = requirePickerState(advanceModelPicker(initialModelPickerState(), 'profile', 'new-session'))
		expect(modelPickerChoices(configuration, profileStage)[0]?.detail).toContain('profile-pinned rlm')
		expect(advanceModelPicker(profileStage, 'pinned', 'new-session')).toEqual({
			_tag: 'profile',
			profile: 'pinned',
		})
	})

	it('stages direct model then mode and supports stepwise escape', () => {
		const provider = requirePickerState(advanceModelPicker(initialModelPickerState(), 'direct', 'new-session'))
		const model = requirePickerState(advanceModelPicker(provider, 'claude-alias', 'new-session'))
		const mode = requirePickerState(advanceModelPicker(model, 'two', 'new-session'))

		expect(mode).toEqual({
			_tag: 'mode',
			selection: { _tag: 'direct', provider: 'claude-alias', model: 'two' },
		})
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

	it('asks for mode when switching an active direct model', () => {
		const model = { _tag: 'model' as const, provider: 'claude-alias' }
		expect(advanceModelPicker(model, 'one', 'active')).toEqual({
			_tag: 'mode',
			selection: { _tag: 'direct', provider: 'claude-alias', model: 'one' },
		})
	})

	it('asks for mode when switching an active profile', () => {
		expect(advanceModelPicker({ _tag: 'profile' }, 'pinned', 'active')).toEqual({
			_tag: 'mode',
			selection: { _tag: 'profile', profile: 'pinned' },
		})
	})
})
