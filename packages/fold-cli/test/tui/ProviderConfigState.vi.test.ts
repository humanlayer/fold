import { describe, expect, it } from 'vitest'

import {
	emptyProviderForm,
	nextProviderKind,
	providerManagementRows,
	providerFormFor,
	providerInput,
	withNextProviderKind,
} from '../../src/tui/ProviderConfigState'

describe('provider config form state', () => {
	const provider = (name: string, kind: 'anthropic' | 'openai-compat' | 'codex' | 'opencode' | 'xai') => ({
		name,
		kind,
		baseUrl: null,
		apiKeyEnv: null,
		credentialPresent: null,
		models: [],
	})

	it('builds the exact canonical management rows around an old config and preserves custom profiles', () => {
		const rows = providerManagementRows({
			profiles: [],
			providers: [
				provider('openai', 'openai-compat'),
				provider('anthropic', 'anthropic'),
				provider('codex', 'codex'),
				provider('local-llama', 'openai-compat'),
			],
		})
		expect(rows.map((row) => row.label)).toEqual([
			'OpenAI',
			'Anthropic',
			'Codex',
			'Grok',
			'OpenCode Zen / Black',
			'local-llama',
			'+ Add OpenAI-compatible',
			'+ Add Anthropic-compatible',
		])
		expect(rows.slice(0, 3).every((row) => row.type === 'configured')).toBe(true)
		expect(rows.slice(3, 5).every((row) => row.type === 'create')).toBe(true)
		expect(rows[5]?.type).toBe('configured')
		expect(rows.slice(6).every((row) => row.type === 'create')).toBe(true)
		expect(rows.map((row) => row.section)).toEqual([
			'api',
			'api',
			'oauth',
			'oauth',
			'oauth',
			'compatible',
			'compatible',
			'compatible',
		])
	})

	it('prefills missing OAuth built-ins and leaves new compatible names blank', () => {
		const rows = providerManagementRows({ profiles: [], providers: [] })
		expect(rows[3]).toMatchObject({
			type: 'create',
			form: { name: 'xai', kind: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.5' },
		})
		expect(rows[4]).toMatchObject({
			type: 'create',
			form: {
				name: 'opencode',
				kind: 'opencode',
				baseUrl: 'https://opencode.ai/zen/v1',
				model: 'gpt-5.6-sol',
			},
		})
		expect(rows[5]).toMatchObject({ type: 'create', form: { name: '', kind: 'openai-compat' } })
		expect(rows[6]).toMatchObject({ type: 'create', form: { name: '', kind: 'anthropic' } })
	})
	it('cycles through API-key and OAuth provider kinds with safe defaults', () => {
		expect(nextProviderKind('anthropic')).toBe('openai-compat')
		expect(nextProviderKind('openai-compat')).toBe('codex')
		expect(nextProviderKind('codex')).toBe('opencode')
		expect(nextProviderKind('opencode')).toBe('xai')
		expect(nextProviderKind('xai')).toBe('anthropic')
		expect(withNextProviderKind({ ...emptyProviderForm(), kind: 'openai-compat' })).toMatchObject({
			kind: 'codex',
			model: 'gpt-5.6-sol',
			baseUrl: 'https://chatgpt.com/backend-api/codex',
			apiKey: '',
		})
	})

	it('omits API keys for OAuth profiles', () => {
		expect(
			providerInput({ ...emptyProviderForm(), kind: 'xai', name: 'grok', apiKey: 'must-not-leak' }),
		).not.toHaveProperty('apiKey')
	})

	it('omits a blank optional model from the API input', () => {
		expect(
			providerInput({ ...emptyProviderForm(), name: 'claude', apiKey: 'secret', model: '  ' }),
		).not.toHaveProperty('model')
	})

	it('prefills an existing non-Codex provider without exposing its key', () => {
		const form = providerFormFor(
			{
				profiles: [],
				providers: [
					{
						name: 'local',
						kind: 'openai-compat',
						baseUrl: 'http://localhost:11434/v1',
						apiKeyEnv: null,
						credentialPresent: true,
						models: ['model-a'],
					},
				],
			},
			'local',
		)
		expect(form).toMatchObject({
			name: 'local',
			kind: 'openai-compat',
			baseUrl: 'http://localhost:11434/v1',
			model: 'model-a',
			apiKey: '',
		})
	})

	it('preserves an existing API key environment reference when editing', () => {
		const form = providerFormFor(
			{
				profiles: [],
				providers: [
					{
						...provider('openai', 'openai-compat'),
						apiKeyEnv: 'OPENAI_API_KEY',
					},
				],
			},
			'openai',
		)
		expect(providerInput(form)).toMatchObject({ apiKeyEnv: 'OPENAI_API_KEY' })
		expect(providerInput(form)).not.toHaveProperty('apiKey')
	})

	it('prefills an OAuth provider base URL and model without a token field value', () => {
		const form = providerFormFor(
			{
				profiles: [],
				providers: [
					{
						name: 'zen',
						kind: 'opencode',
						baseUrl: null,
						apiKeyEnv: null,
						credentialPresent: null,
						models: [],
					},
				],
			},
			'zen',
		)
		expect(form).toMatchObject({
			kind: 'opencode',
			baseUrl: 'https://opencode.ai/zen/v1',
			model: 'gpt-5.6-sol',
			apiKey: '',
		})
	})
})
