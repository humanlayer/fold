import type { ConfigureProviderInput, ModelConfiguration } from '@humanlayer/fold-agent'

export type ProviderFormField = 'kind' | 'name' | 'baseUrl' | 'apiKey' | 'model'
export const providerFormFields: ReadonlyArray<ProviderFormField> = ['kind', 'name', 'baseUrl', 'apiKey', 'model']

export type ProviderForm = ConfigureProviderInput & { readonly model: string }

type ConfiguredProvider = ModelConfiguration['providers'][number]

export type ProviderManagementRow =
	| {
			readonly type: 'configured'
			readonly section: 'api' | 'oauth' | 'compatible'
			readonly label: string
			readonly provider: ConfiguredProvider
	  }
	| {
			readonly type: 'create'
			readonly section: 'api' | 'oauth' | 'compatible'
			readonly label: string
			readonly form: ProviderForm
	  }

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
	if (kind === 'xai') return { baseUrl: 'https://api.x.ai/v1', model: 'grok-4.5' }
	if (kind === 'anthropic') return { baseUrl: 'https://api.anthropic.com', model: '' }
	return { baseUrl: 'https://api.openai.com/v1', model: '' }
}

const createForm = (name: string, kind: ProviderForm['kind']): ProviderForm => ({
	kind,
	name,
	...defaults(kind),
	apiKey: '',
})

const canonicalRows: ReadonlyArray<{
	readonly section: 'api' | 'oauth'
	readonly label: string
	readonly names: ReadonlyArray<string>
	readonly form: ProviderForm
}> = [
	{ section: 'api', label: 'OpenAI', names: ['openai'], form: createForm('openai', 'openai-compat') },
	{ section: 'api', label: 'Anthropic', names: ['anthropic'], form: createForm('anthropic', 'anthropic') },
	{ section: 'oauth', label: 'Codex', names: ['codex'], form: createForm('codex', 'codex') },
	{ section: 'oauth', label: 'Grok', names: ['xai', 'grok'], form: createForm('xai', 'xai') },
	{
		section: 'oauth',
		label: 'OpenCode Zen / Black',
		names: ['opencode', 'zen'],
		form: createForm('opencode', 'opencode'),
	},
]

/** Rows belong to provider management only; virtual entries never enter model selection config. */
export const providerManagementRows = (configuration: ModelConfiguration): ReadonlyArray<ProviderManagementRow> => {
	const claimed = new Set<string>()
	const rows: Array<ProviderManagementRow> = canonicalRows.map((canonical) => {
		const provider = configuration.providers.find(
			(candidate) => canonical.names.includes(candidate.name) && candidate.kind === canonical.form.kind,
		)
		if (provider === undefined)
			return { type: 'create', section: canonical.section, label: canonical.label, form: canonical.form }
		claimed.add(provider.name)
		return { type: 'configured', section: canonical.section, label: canonical.label, provider }
	})
	for (const provider of configuration.providers) {
		if (!claimed.has(provider.name))
			rows.push({ type: 'configured', section: 'compatible', label: provider.name, provider })
	}
	rows.push(
		{
			type: 'create',
			section: 'compatible',
			label: '+ Add OpenAI-compatible',
			form: createForm('', 'openai-compat'),
		},
		{
			type: 'create',
			section: 'compatible',
			label: '+ Add Anthropic-compatible',
			form: createForm('', 'anthropic'),
		},
	)
	return rows
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
		...(provider.apiKeyEnv === null ? {} : { apiKeyEnv: provider.apiKeyEnv }),
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
	return {
		...required,
		...(oauth || apiKey === undefined || apiKey.trim() === '' ? {} : { apiKey }),
		...(model.trim() === '' ? {} : { model }),
	}
}
