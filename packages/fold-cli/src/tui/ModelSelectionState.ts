import type { ConfiguredModelSelection, ModelConfiguration, ProfileModeName } from '@humanlayer/fold-agent'

export type ModelSelectionContext = 'active' | 'new-session'
export type ModelSelectionRequest =
	| { readonly _tag: 'profile'; readonly profile: string }
	| { readonly _tag: 'direct'; readonly provider: string; readonly model: string; readonly mode?: ProfileModeName }
export type ModelPickerState =
	| { readonly _tag: 'kind' }
	| { readonly _tag: 'profile' }
	| { readonly _tag: 'provider' }
	| { readonly _tag: 'model'; readonly provider: string }
	| { readonly _tag: 'mode'; readonly provider: string; readonly model: string }
export type ModelPickerChoice = { readonly id: string; readonly label: string; readonly detail: string }

export const configuredSelection = (request: ModelSelectionRequest): ConfiguredModelSelection =>
	request._tag === 'profile' ? request : { _tag: 'direct', provider: request.provider, model: request.model }

export const initialModelPickerState = (): ModelPickerState => ({ _tag: 'kind' })
export const modelPickerChoices = (
	configuration: ModelConfiguration,
	state: ModelPickerState,
): ReadonlyArray<ModelPickerChoice> => {
	switch (state._tag) {
		case 'kind':
			return [
				{ id: 'direct', label: 'Direct model', detail: 'Provider and model' },
				{ id: 'profile', label: 'Profile', detail: 'Configured root and role models' },
			]
		case 'profile':
			return configuration.profiles.map(({ name, mode }) => ({
				id: name,
				label: name,
				detail: mode === null ? 'configured defaults' : `profile-pinned ${mode} mode`,
			}))
		case 'provider':
			return configuration.providers
				.toSorted((left, right) => {
					if (left.name === 'codex') return -1
					if (right.name === 'codex') return 1
					return left.name.localeCompare(right.name)
				})
				.map((provider) => ({
					id: provider.name,
					label: provider.name,
					detail: `${provider.kind}${provider.credentialPresent === false ? ' · credential missing' : ''}`,
				}))
		case 'model':
			return (configuration.providers.find(({ name }) => name === state.provider)?.models ?? [])
				.toSorted((left, right) => {
					if (left === 'gpt-5.6-sol') return -1
					if (right === 'gpt-5.6-sol') return 1
					return left.localeCompare(right)
				})
				.map((model) => ({
					id: model,
					label: model,
					detail: state.provider,
				}))
		case 'mode':
			return [
				{ id: 'default', label: 'Default', detail: 'Smart root with standard tools' },
				{ id: 'rlm', label: 'RLM', detail: 'Orchestrator root with RLM tools' },
			]
	}
}
export const advanceModelPicker = (
	state: ModelPickerState,
	choice: string,
	context: ModelSelectionContext,
): ModelPickerState | ModelSelectionRequest => {
	switch (state._tag) {
		case 'kind':
			return choice === 'profile' ? { _tag: 'profile' } : { _tag: 'provider' }
		case 'profile':
			return { _tag: 'profile', profile: choice }
		case 'provider':
			return { _tag: 'model', provider: choice }
		case 'model':
			return context === 'new-session'
				? { _tag: 'mode', provider: state.provider, model: choice }
				: { _tag: 'direct', provider: state.provider, model: choice }
		case 'mode':
			return {
				_tag: 'direct',
				provider: state.provider,
				model: state.model,
				mode: choice === 'rlm' ? 'rlm' : 'default',
			}
	}
}
export const retreatModelPicker = (state: ModelPickerState): ModelPickerState | null => {
	switch (state._tag) {
		case 'kind':
			return null
		case 'profile':
		case 'provider':
			return { _tag: 'kind' }
		case 'model':
			return { _tag: 'provider' }
		case 'mode':
			return { _tag: 'model', provider: state.provider }
	}
}
