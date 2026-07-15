import type { ConfigureProviderInput, ModelConfiguration } from '@humanlayer/fold-agent'

export type ProviderFormField = 'kind' | 'name' | 'baseUrl' | 'apiKey' | 'model'
export const providerFormFields: ReadonlyArray<ProviderFormField> = ['kind', 'name', 'baseUrl', 'apiKey', 'model']

export type ProviderForm = ConfigureProviderInput & { readonly model: string }

export const emptyProviderForm = (): ProviderForm => ({
	kind: 'anthropic',
	name: '',
	baseUrl: 'https://api.anthropic.com',
	apiKey: '',
	model: '',
})

const defaults = (kind: ProviderForm['kind']): Pick<ProviderForm, 'baseUrl' | 'model'> => {
	if (kind === 'codex') return { baseUrl: 'https://chatgpt.com/backend-api/codex', model: 'gpt-5.6-sol' }
	if (kind === 'opencode') return { baseUrl: 'https://opencode.ai/zen/v1', model: 'gpt-5.6-sol' }
	if (kind === 'xai') return { baseUrl: 'https://api.x.ai/v1', model: 'grok-4' }
	if (kind === 'anthropic') return { baseUrl: 'https://api.anthropic.com', model: '' }
	return { baseUrl: 'https://api.openai.com/v1', model: '' }
}

export const providerFormFor = (configuration: ModelConfiguration, name: string): ProviderForm => {
	const provider = configuration.providers.find((candidate) => candidate.name === name)
	if (provider === undefined) return emptyProviderForm()
	const fallback = defaults(provider.kind)
	return {
		kind: provider.kind,
		name: provider.name,
		baseUrl: provider.baseUrl ?? fallback.baseUrl,
		apiKey: '',
		model: provider.models[0] ?? fallback.model,
	}
}

const nextKinds: Record<ProviderForm['kind'], ProviderForm['kind']> = {
	anthropic: 'openai-compat',
	'openai-compat': 'codex',
	codex: 'opencode',
	opencode: 'xai',
	xai: 'anthropic',
}

export const nextProviderKind = (kind: ProviderForm['kind']): ProviderForm['kind'] => nextKinds[kind]

export const withNextProviderKind = (form: ProviderForm): ProviderForm => {
	const kind = nextProviderKind(form.kind)
	return { ...form, kind, ...defaults(kind), apiKey: '' }
}

export const providerInput = (form: ProviderForm): ConfigureProviderInput => {
	const { model, apiKey, ...required } = form
	const oauth = form.kind === 'codex' || form.kind === 'opencode' || form.kind === 'xai'
	return { ...required, ...(oauth ? {} : { apiKey }), ...(model.trim() === '' ? {} : { model }) }
}
