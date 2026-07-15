/**
 * ModelCatalog contract tests (D15): lookup precedence over the entry list - an exact (candidate
 * provider id, model id) hit wins, provider kinds map onto catalog provider ids (anthropic ->
 * anthropic, codex -> openai, openai-compatible -> its providerId then openai), the bare-model-id
 * fallback prefers anthropic then openai then first-seen, misses are null - and the Context.Reference
 * default resolves the empty catalog without any layer.
 */
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import {
	lookupCatalogEntry,
	ModelCatalog,
	modelCatalogFromEntries,
	type ActiveModel,
	type AnthropicActiveModel,
	type CodexActiveModel,
	type ModelCatalogEntry,
	type OpenAiCompatibleActiveModel,
} from '../../src/index'

const entry = (
	overrides: Partial<ModelCatalogEntry> & Pick<ModelCatalogEntry, 'providerId' | 'modelId'>,
): ModelCatalogEntry => ({
	name: null,
	contextWindow: 200_000,
	maxInputTokens: null,
	maxOutputTokens: 32_000,
	reasoning: true,
	reasoningEfforts: null,
	vision: true,
	toolCall: true,
	pricing: null,
	...overrides,
})

const openaiCompatibleModel = (providerId: string, modelId: string): OpenAiCompatibleActiveModel => ({
	providerId,
	providerKind: 'openai-compatible',
	modelId,
	role: null,
	requestedReasoningLevel: 'off',
	reasoning: { _tag: 'disabled' },
})

const anthropicKindModel = (modelId: string): AnthropicActiveModel => ({
	providerId: 'my-anthropic-profile',
	providerKind: 'anthropic',
	modelId,
	role: null,
	requestedReasoningLevel: 'off',
	thinking: { _tag: 'disabled' },
})

const codexKindModel = (modelId: string): CodexActiveModel => ({
	providerId: 'codex',
	providerKind: 'codex',
	modelId,
	role: null,
	requestedReasoningLevel: 'off',
	reasoning: { _tag: 'disabled' },
})

it('an exact (provider, model) hit wins over bare-model-id matches', () => {
	const entries = [
		entry({ providerId: 'google', modelId: 'shared-model', contextWindow: 1 }),
		entry({ providerId: 'openai', modelId: 'shared-model', contextWindow: 2 }),
	]

	expect(lookupCatalogEntry(entries, openaiCompatibleModel('openai', 'shared-model'))?.contextWindow).toBe(2)
})

it('the anthropic kind matches the anthropic catalog provider, whatever the configured profile name', () => {
	const entries = [
		entry({ providerId: 'openai', modelId: 'claude-opus-4-8', contextWindow: 1 }),
		entry({ providerId: 'anthropic', modelId: 'claude-opus-4-8', contextWindow: 2 }),
	]

	expect(lookupCatalogEntry(entries, anthropicKindModel('claude-opus-4-8'))?.contextWindow).toBe(2)
})

it('the codex kind matches openai catalog entries', () => {
	const entries = [entry({ providerId: 'openai', modelId: 'gpt-5.5', contextWindow: 1_050_000 })]

	expect(lookupCatalogEntry(entries, codexKindModel('gpt-5.5'))?.contextWindow).toBe(1_050_000)
})

it('an openai-compatible model tries its own provider id first, then openai', () => {
	const entries = [
		entry({ providerId: 'my-proxy', modelId: 'm-1', contextWindow: 1 }),
		entry({ providerId: 'openai', modelId: 'm-1', contextWindow: 2 }),
	]

	expect(lookupCatalogEntry(entries, openaiCompatibleModel('my-proxy', 'm-1'))?.contextWindow).toBe(1)
	expect(lookupCatalogEntry(entries, openaiCompatibleModel('unknown-profile', 'm-1'))?.contextWindow).toBe(2)
})

it('the bare-model-id fallback prefers anthropic, then openai, then first-seen', () => {
	const model = openaiCompatibleModel('unlisted-profile', 'm-2')

	const withAnthropic = [
		entry({ providerId: 'zeta', modelId: 'm-2', contextWindow: 1 }),
		entry({ providerId: 'anthropic', modelId: 'm-2', contextWindow: 2 }),
	]
	expect(lookupCatalogEntry(withAnthropic, model)?.providerId).toBe('anthropic')

	const withoutAnthropic = [
		entry({ providerId: 'zeta', modelId: 'm-2', contextWindow: 1 }),
		entry({ providerId: 'openai-proxy-vendor', modelId: 'm-2', contextWindow: 2 }),
	]
	expect(lookupCatalogEntry(withoutAnthropic, model)?.providerId).toBe('zeta')
})

it('a model the catalog does not know returns null', () => {
	const entries = [entry({ providerId: 'anthropic', modelId: 'claude-opus-4-8' })]

	expect(lookupCatalogEntry(entries, openaiCompatibleModel('openai', 'gpt-unknown'))).toBeNull()
	expect(lookupCatalogEntry([], anthropicKindModel('claude-opus-4-8'))).toBeNull()
})

it.effect('the service built from entries answers through the same matching logic', () =>
	Effect.gen(function* () {
		const entries = [entry({ providerId: 'anthropic', modelId: 'claude-fable-5', contextWindow: 1_000_000 })]
		const catalog = modelCatalogFromEntries(entries)

		const hit = yield* catalog.lookup(anthropicKindModel('claude-fable-5'))
		expect(hit?.contextWindow).toBe(1_000_000)

		const miss = yield* catalog.lookup(codexKindModel('claude-fable-5'))
		// codex candidates are ['openai'], and the bare-model fallback still finds the anthropic row.
		expect(miss?.providerId).toBe('anthropic')

		expect(yield* catalog.lookup(openaiCompatibleModel('openai', 'nope'))).toBeNull()
	}),
)

it.effect('the ModelCatalog reference defaults to the empty catalog: lookup is always null', () =>
	Effect.gen(function* () {
		const catalog = yield* ModelCatalog
		const model: ActiveModel = anthropicKindModel('claude-opus-4-8')

		expect(yield* catalog.lookup(model)).toBeNull()
	}),
)
