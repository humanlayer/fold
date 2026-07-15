import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import {
	DEFAULT_OPENCODE_MODEL_ID,
	GROK_BUILD_MODEL_ID,
	grokBuildModel,
	openCodeModel,
	OPENCODE_INFERENCE_API_URL,
	OPENCODE_ZEN_API_URL,
	resolveOpenCodeModelConfig,
} from '../src/OpenCodeModel'

describe('openCodeModel', () => {
	it('creates a fold-agent compatible custom descriptor', () => {
		const model = openCodeModel({ reasoning: 'high' })
		expect(model.activeModel).toMatchObject({
			providerId: 'opencode',
			providerKind: 'openai-compatible',
			modelId: DEFAULT_OPENCODE_MODEL_ID,
			requestedReasoningLevel: 'high',
		})
		expect(model.provider._tag).toBe('custom')
		expect(OPENCODE_INFERENCE_API_URL).toBe('https://opencode.ai/zen/v1')
	})

	it('uses the model provider override and chat protocol for Grok Build', () => {
		const resolved = resolveOpenCodeModelConfig(
			{
				opencode: {
					api: 'https://provider.example/responses',
					npm: '@ai-sdk/openai',
					models: {
						[GROK_BUILD_MODEL_ID]: {
							id: 'upstream-grok-id',
							provider: {
								api: 'https://opencode.ai/zen/v1',
								npm: '@ai-sdk/openai-compatible',
							},
						},
					},
				},
			},
			GROK_BUILD_MODEL_ID,
		)

		expect(resolved).toEqual({
			apiUrl: 'https://opencode.ai/zen/v1',
			model: 'upstream-grok-id',
			packageName: '@ai-sdk/openai-compatible',
			protocol: 'chat-completions',
		})
		expect(grokBuildModel().activeModel.modelId).toBe(GROK_BUILD_MODEL_ID)
	})

	it('uses provider Responses settings and lets an explicit API URL win', () => {
		const providers = {
			opencode: {
				api: 'https://remote.example/v1',
				npm: '@ai-sdk/openai',
				models: { [DEFAULT_OPENCODE_MODEL_ID]: {} },
			},
		}
		expect(resolveOpenCodeModelConfig(providers, DEFAULT_OPENCODE_MODEL_ID)).toMatchObject({
			apiUrl: 'https://remote.example/v1',
			protocol: 'responses',
		})
		expect(resolveOpenCodeModelConfig(providers, DEFAULT_OPENCODE_MODEL_ID, OPENCODE_ZEN_API_URL)).toMatchObject({
			apiUrl: 'https://remote.example/v1',
			protocol: 'responses',
		})
		expect(
			resolveOpenCodeModelConfig(providers, DEFAULT_OPENCODE_MODEL_ID, 'https://override.example/v1'),
		).toMatchObject({ apiUrl: 'https://override.example/v1', protocol: 'responses' })
	})

	it('falls back unknown models to the public Zen base', () => {
		expect(resolveOpenCodeModelConfig(undefined, 'unknown')).toEqual({
			apiUrl: OPENCODE_ZEN_API_URL,
			model: 'unknown',
			packageName: undefined,
			protocol: 'responses',
		})
	})
})
