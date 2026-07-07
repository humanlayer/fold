import { expect, it } from '@effect/vitest'

import { modelFamilyFor, type ActiveModel } from '../../src/index'

const anthropicModel: ActiveModel = {
	providerId: 'anthropic',
	providerKind: 'anthropic',
	modelId: 'claude-opus-4-8',
	role: null,
	requestedReasoningLevel: 'off',
	thinking: { _tag: 'disabled' },
}

const codexModel: ActiveModel = {
	providerId: 'codex',
	providerKind: 'codex',
	modelId: 'gpt-5.5',
	role: null,
	requestedReasoningLevel: 'medium',
	reasoning: { _tag: 'effort', effort: 'medium', summary: 'auto' },
}

const openAiCompatible = (modelId: string): ActiveModel => ({
	providerId: 'openai',
	providerKind: 'openai-compatible',
	modelId,
	role: null,
	requestedReasoningLevel: 'off',
	reasoning: { _tag: 'disabled' },
})

it('classifies by provider kind first', () => {
	expect(modelFamilyFor(anthropicModel)).toBe('claude')
	expect(modelFamilyFor(codexModel)).toBe('codex')
})

it('classifies openai-compatible models by model id patterns', () => {
	expect(modelFamilyFor(openAiCompatible('gpt-5.5'))).toBe('gpt')
	expect(modelFamilyFor(openAiCompatible('o3-mini'))).toBe('gpt')
	expect(modelFamilyFor(openAiCompatible('gpt-5.1-codex-max'))).toBe('codex')
	expect(modelFamilyFor(openAiCompatible('anthropic/claude-opus-4-8'))).toBe('claude')
	expect(modelFamilyFor(openAiCompatible('llama-3.3-70b'))).toBe('unknown')
})
