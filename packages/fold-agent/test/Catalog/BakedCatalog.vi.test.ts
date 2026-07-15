/**
 * Baked-catalog resolution tests for the gpt-5.6 model family (D23): the codex provider kind maps
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

const openAiTerra: ActiveModel = {
	providerId: 'openai',
	providerKind: 'openai-compatible',
	modelId: 'gpt-5.6-terra',
	role: null,
	requestedReasoningLevel: 'max',
	reasoning: { _tag: 'effort', effort: 'max' },
}

it('resolves a codex-kind gpt-5.6-sol to the baked openai entry', () => {
	const entry = lookupCatalogEntry(bakedModelCatalog, codexSol)

	expect(entry).not.toBeNull()
	expect(entry?.providerId).toBe('openai')
	expect(entry?.modelId).toBe('gpt-5.6-sol')
	expect(entry?.contextWindow).toBe(1050000)
	expect(entry?.pricing?.inputPerMTokens).toBe(5)
	expect(entry?.pricing?.outputPerMTokens).toBe(30)
	expect(entry?.reasoningEfforts).toContain('max')
})

it('resolves an openai-compatible gpt-5.6-terra to the baked openai entry', () => {
	const entry = lookupCatalogEntry(bakedModelCatalog, openAiTerra)

	expect(entry).not.toBeNull()
	expect(entry?.providerId).toBe('openai')
	expect(entry?.modelId).toBe('gpt-5.6-terra')
	expect(entry?.contextWindow).toBe(1050000)
	expect(entry?.pricing?.inputPerMTokens).toBe(2.5)
	expect(entry?.pricing?.outputPerMTokens).toBe(15)
	expect(entry?.reasoningEfforts).toContain('max')
})
