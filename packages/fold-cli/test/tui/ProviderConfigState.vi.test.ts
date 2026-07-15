import { describe, expect, it } from 'vitest'

import {
	emptyProviderForm,
	nextProviderKind,
	providerFormFor,
	providerInput,
	withNextProviderKind,
} from '../../src/tui/ProviderConfigState'

describe('provider config form state', () => {
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
