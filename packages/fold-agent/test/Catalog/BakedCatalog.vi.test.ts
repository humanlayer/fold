/**
 * Baked-catalog resolution tests for current Codex models (D23): the codex provider kind maps
 * onto the models.dev `openai` provider id, so a codex-kind ActiveModel resolves the same catalog
 * entry an openai-compatible one does. Asserting limits, pricing, and the `max` effort level against
 * the shipped data proves the entries that make `reasoning: max` valid for these models are live.
 */
import { expect, it } from '@effect/vitest'
import { lookupCatalogEntry } from '@humanlayer/fold-core'
import type { ActiveModel } from '@humanlayer/fold-core'

import { bakedModelCatalog } from '../../src/index'

const codexSol: ActiveModel = {
	providerId: 'codex',
	providerKind: 'codex',
	modelId: 'gpt-5.6-sol',
	role: null,
	requestedReasoningLevel: 'max',
	reasoning: { _tag: 'effort', effort: 'max', summary: 'auto' },
}

const codexAstra: ActiveModel = {
	providerId: 'codex',
	providerKind: 'codex',
	modelId: 'gpt-6-astra',
	role: null,
	requestedReasoningLevel: 'max',
	reasoning: { _tag: 'effort', effort: 'max', summary: 'auto' },
}

const openAiTerra: ActiveModel = {
	providerId: 'openai',
	providerKind: 'openai-compatible',
	modelId: 'gpt-5.6-terra',
	role: null,
	requestedReasoningLevel: 'max',
	reasoning: { _tag: 'effort', effort: 'max' },
}

const xaiGrok: ActiveModel = {
	providerId: 'xai',
	providerKind: 'openai-compatible',
	modelId: 'grok-4.6',
	role: null,
	requestedReasoningLevel: 'xhigh',
	reasoning: { _tag: 'effort', effort: 'xhigh' },
}

const codexModel = (modelId: string): ActiveModel => ({
	providerId: 'codex',
	providerKind: 'codex',
	modelId,
	role: null,
	requestedReasoningLevel: 'max',
	reasoning: { _tag: 'effort', effort: 'max', summary: 'auto' },
})

it('resolves a codex-kind gpt-5.6-sol to the baked openai entry', () => {
	const entry = lookupCatalogEntry(bakedModelCatalog, codexSol)

	expect(entry).not.toBeNull()
	expect(entry?.providerId).toBe('openai')
	expect(entry?.modelId).toBe('gpt-5.6-sol')
	expect(entry?.contextWindow).toBe(1050000)
	expect(entry?.pricing?.inputPerMTokens).toBe(4)
	expect(entry?.pricing?.outputPerMTokens).toBe(20)
	expect(entry?.reasoningEfforts).toContain('max')
})

it('resolves a codex-kind gpt-6-astra to the baked OpenAI entry', () => {
	const entry = lookupCatalogEntry(bakedModelCatalog, codexAstra)

	expect(entry).not.toBeNull()
	expect(entry?.providerId).toBe('openai')
	expect(entry?.modelId).toBe('gpt-6-astra')
	expect(entry?.contextWindow).toBe(1_050_000)
	expect(entry?.maxInputTokens).toBe(922_000)
	expect(entry?.pricing?.inputPerMTokens).toBe(10)
	expect(entry?.pricing?.outputPerMTokens).toBe(50)
	expect(entry?.reasoningEfforts).toContain('max')
})

it('ships the GPT-6 Sol and Luna public limits, efforts, pricing, and Codex provider lookup', () => {
	const expectations = [
		{ modelId: 'gpt-6-sol', inputPrice: 2, outputPrice: 10 },
		{ modelId: 'gpt-6-luna', inputPrice: 0.1, outputPrice: 0.5 },
	] as const

	for (const expected of expectations) {
		const entry = lookupCatalogEntry(bakedModelCatalog, codexModel(expected.modelId))

		expect(entry).not.toBeNull()
		expect(entry).toMatchObject({
			providerId: 'openai',
			modelId: expected.modelId,
			contextWindow: 1_050_000,
			maxInputTokens: 922_000,
			maxOutputTokens: 128_000,
			reasoning: true,
			reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
		})
		expect(entry?.pricing?.inputPerMTokens).toBe(expected.inputPrice)
		expect(entry?.pricing?.outputPerMTokens).toBe(expected.outputPrice)
	}
})

it('resolves an openai-compatible gpt-5.6-terra to the baked openai entry', () => {
	const entry = lookupCatalogEntry(bakedModelCatalog, openAiTerra)

	expect(entry).not.toBeNull()
	expect(entry?.providerId).toBe('openai')
	expect(entry?.modelId).toBe('gpt-5.6-terra')
	expect(entry?.contextWindow).toBe(1050000)
	expect(entry?.pricing?.inputPerMTokens).toBe(2)
	expect(entry?.pricing?.outputPerMTokens).toBe(12)
	expect(entry?.reasoningEfforts).toContain('max')
})

it('resolves the supported Grok model to the baked xAI entry', () => {
	const entry = lookupCatalogEntry(bakedModelCatalog, xaiGrok)

	expect(entry).not.toBeNull()
	expect(entry?.providerId).toBe('xai')
	expect(entry?.modelId).toBe('grok-4.6')
	expect(entry?.contextWindow).toBe(500_000)
	expect(entry?.pricing?.inputPerMTokens).toBe(2)
	expect(entry?.pricing?.outputPerMTokens).toBe(6)
	expect(entry?.reasoningEfforts).toContain('xhigh')
})
