import type { ConfiguredModelSelection, ModelConfiguration, ProfileModeName } from '@humanlayer/fold-agent'
import type { ReasoningLevel } from '@humanlayer/fold-core'

type Mutable<Type> = { -readonly [Key in keyof Type]: Type[Key] }

export type ModelSelectionContext = 'active' | 'new-session'
export type ModelSelectionRequest =
	| { readonly _tag: 'profile'; readonly profile: string; readonly mode?: ProfileModeName }
	| {
			readonly _tag: 'direct'
			readonly provider: string
			readonly model: string
			readonly reasoning?: ReasoningLevel
			readonly mode?: ProfileModeName
	  }
type StagedModelSelection =
	| { readonly _tag: 'profile'; readonly profile: string }
	| { readonly _tag: 'direct'; readonly provider: string; readonly model: string }
export type ModelPickerState =
	| { readonly _tag: 'kind' }
	| { readonly _tag: 'profile' }
	| { readonly _tag: 'provider' }
	| { readonly _tag: 'model'; readonly provider: string }
	| { readonly _tag: 'reasoning'; readonly selection: StagedModelSelection }
	| { readonly _tag: 'mode'; readonly selection: StagedModelSelection; readonly reasoning?: ReasoningLevel }
export type ModelPickerChoice = { readonly id: string; readonly label: string; readonly detail: string }

export const configuredSelection = (request: ModelSelectionRequest): ConfiguredModelSelection => {
	if (request._tag === 'profile') return request

	const selection: Mutable<Extract<ConfiguredModelSelection, { readonly _tag: 'direct' }>> = {
		_tag: 'direct',
		provider: request.provider,
		model: request.model,
	}
	if (request.reasoning !== undefined) selection.reasoning = request.reasoning
	return selection
}

const REASONING_LEVELS: ReadonlyArray<{ id: ReasoningLevel; label: string; detail: string }> = [
	{ id: 'off', label: 'Off', detail: 'No extended thinking' },
	{ id: 'low', label: 'Low', detail: 'Minimal reasoning' },
	{ id: 'medium', label: 'Medium', detail: 'Moderate reasoning' },
	{ id: 'high', label: 'High', detail: 'Thorough reasoning' },
	{ id: 'max', label: 'Max', detail: 'Maximum reasoning depth' },
]

const toReasoningLevel = (choice: string): ReasoningLevel => REASONING_LEVELS.find((l) => l.id === choice)?.id ?? 'off'

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
		case 'reasoning':
			return REASONING_LEVELS
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
			return context === 'active'
				? { _tag: 'mode', selection: { _tag: 'profile', profile: choice } }
				: { _tag: 'profile', profile: choice }
		case 'provider':
			return { _tag: 'model', provider: choice }
		case 'model':
			return { _tag: 'reasoning', selection: { _tag: 'direct', provider: state.provider, model: choice } }
		case 'reasoning': {
			const next: Mutable<Extract<ModelPickerState, { readonly _tag: 'mode' }>> = {
				_tag: 'mode',
				selection: state.selection,
			}
			if (choice !== 'off') next.reasoning = toReasoningLevel(choice)
			return next
		}
		case 'mode': {
			const mode = choice === 'rlm' ? 'rlm' : 'default'
			if (state.selection._tag === 'profile') return { ...state.selection, mode }

			const selection: Mutable<Extract<ModelSelectionRequest, { readonly _tag: 'direct' }>> = {
				...state.selection,
				mode,
			}
			if (state.reasoning !== undefined) selection.reasoning = state.reasoning
			return selection
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
		case 'reasoning':
			return state.selection._tag === 'profile'
				? { _tag: 'profile' }
				: { _tag: 'model', provider: state.selection.provider }
		case 'mode':
			return { _tag: 'reasoning', selection: state.selection }
	}
}
