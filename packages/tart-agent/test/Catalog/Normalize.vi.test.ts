/**
 * models.dev decode + normalization tests (D15): the two research-verified sample models map onto the
 * expected ModelCatalogEntry rows (limits, pricing incl. null cache-write, effort lists, vision), the
 * null-cases hold (no cost -> null pricing, toggle-style reasoning -> null efforts, no image modality
 * -> vision false), models lacking a usable limit are dropped, and the permissive decoder skips a
 * malformed model/provider without killing the rest of the catalog.
 */
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import {
	decodeModelsDevModels,
	modelCatalogEntriesFromModelsDev,
	modelCatalogEntryFromModelsDev,
} from '../../src/index'

/** The real anthropic/claude-opus-4-8 row (research-verified sample, 2026-07-09). */
const opusModel = {
	id: 'claude-opus-4-8',
	name: 'Claude Opus 4.8',
	attachment: true,
	reasoning: true,
	tool_call: true,
	release_date: '2026-05-01',
	last_updated: '2026-05-01',
	modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
	open_weights: false,
	limit: { context: 1_000_000, output: 128_000 },
	cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
	reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
}

/** The real openai/gpt-5.5 row (research-verified sample; `tiers` proves excess fields are tolerated). */
const gptModel = {
	id: 'gpt-5.5',
	name: 'GPT-5.5',
	attachment: true,
	reasoning: true,
	tool_call: true,
	release_date: '2026-01-15',
	last_updated: '2026-01-15',
	modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
	open_weights: false,
	limit: { context: 1_050_000, input: 922_000, output: 128_000 },
	cost: {
		input: 5,
		output: 30,
		cache_read: 0.5,
		tiers: [{ input: 10, output: 45, cache_read: 1, tier: { type: 'context', size: 272_000 } }],
	},
	reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }],
}

const payload = {
	anthropic: { id: 'anthropic', name: 'Anthropic', models: { 'claude-opus-4-8': opusModel } },
	openai: { id: 'openai', name: 'OpenAI', models: { 'gpt-5.5': gptModel } },
}

it.effect('normalizes the real anthropic and openai samples to the expected entries', () =>
	Effect.gen(function* () {
		const models = yield* decodeModelsDevModels(payload)
		const entries = modelCatalogEntriesFromModelsDev(models)

		expect(entries).toHaveLength(2)
		expect(entries.find((entry) => entry.providerId === 'anthropic')).toEqual({
			providerId: 'anthropic',
			modelId: 'claude-opus-4-8',
			name: 'Claude Opus 4.8',
			contextWindow: 1_000_000,
			maxInputTokens: null,
			maxOutputTokens: 128_000,
			reasoning: true,
			reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
			vision: true,
			toolCall: true,
			pricing: {
				inputPerMTokens: 5,
				outputPerMTokens: 25,
				cacheReadPerMTokens: 0.5,
				cacheWritePerMTokens: 6.25,
			},
		})
		expect(entries.find((entry) => entry.providerId === 'openai')).toEqual({
			providerId: 'openai',
			modelId: 'gpt-5.5',
			name: 'GPT-5.5',
			contextWindow: 1_050_000,
			maxInputTokens: 922_000,
			maxOutputTokens: 128_000,
			reasoning: true,
			reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
			vision: true,
			toolCall: true,
			pricing: {
				inputPerMTokens: 5,
				outputPerMTokens: 30,
				cacheReadPerMTokens: 0.5,
				cacheWritePerMTokens: null,
			},
		})
	}),
)

it.effect('null-cases: no cost, toggle-style reasoning, text-only modalities, missing limit', () =>
	Effect.gen(function* () {
		const models = yield* decodeModelsDevModels({
			acme: {
				models: {
					'plain-model': {
						reasoning: true,
						tool_call: false,
						modalities: { input: ['text'], output: ['text'] },
						limit: { context: 8_000, output: 1_000 },
						reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', min: 1_024, max: 32_000 }],
					},
					'no-limit-model': {
						reasoning: false,
						tool_call: true,
					},
				},
			},
		})

		const plain = models.find((named) => named.modelId === 'plain-model')
		if (plain === undefined) throw new Error('expected plain-model to decode')
		expect(modelCatalogEntryFromModelsDev(plain)).toEqual({
			providerId: 'acme',
			modelId: 'plain-model',
			name: null,
			contextWindow: 8_000,
			maxInputTokens: null,
			maxOutputTokens: 1_000,
			reasoning: true,
			reasoningEfforts: null,
			vision: false,
			toolCall: false,
			pricing: null,
		})

		// Decodes fine, but normalization drops it: no usable limit to budget against.
		const noLimit = models.find((named) => named.modelId === 'no-limit-model')
		if (noLimit === undefined) throw new Error('expected no-limit-model to decode')
		expect(modelCatalogEntryFromModelsDev(noLimit)).toBeNull()
		expect(modelCatalogEntriesFromModelsDev(models)).toHaveLength(1)
	}),
)

it.effect('a malformed model or provider is skipped; the rest of the catalog survives', () =>
	Effect.gen(function* () {
		const models = yield* decodeModelsDevModels({
			broken: 'not a provider object',
			acme: {
				models: {
					'bad-model': { reasoning: 'yes', tool_call: true },
					'good-model': { reasoning: false, tool_call: true, limit: { context: 4_000, output: 500 } },
				},
			},
		})

		expect(models.map((named) => `${named.providerId}/${named.modelId}`)).toEqual(['acme/good-model'])
	}),
)

it.effect('a payload that is not a provider map fails with ModelsDevDecodeError', () =>
	Effect.gen(function* () {
		const error = yield* decodeModelsDevModels('<!doctype html>').pipe(Effect.flip)
		expect(error._tag).toBe('ModelsDevDecodeError')
	}),
)
