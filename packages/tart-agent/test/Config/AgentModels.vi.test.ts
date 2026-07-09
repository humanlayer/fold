/**
 * AgentModels role-resolution tests (D25): a config role resolves to a runnable TartModel descriptor
 * for each provider kind (anthropic / openai-compat / codex), `orchestrator` falls back to `smart` when
 * unbound, the requested role is stamped on the model snapshot, reasoning flows through, and a missing
 * credential env var is a typed RoleResolutionError. Descriptors are plain data (codex's provider layer
 * is lazy), so nothing here touches the network. With a catalog, resolution also validates the bound
 * reasoning level against per-model support (D23): reasoning-incapable models reject any level but
 * 'off', effort-listed models reject unlisted levels naming the supported ones, and unknown models
 * pass through permissively.
 */
import { expect, it } from '@effect/vitest'
import type { ModelCatalogEntry } from '@humanlayer/tart-core'
import { Effect } from 'effect'

import { agentModelsFromConfig, bakedModelCatalog, parseTartConfig } from '../../src/index'

const configText = `{
	"providers": {
		"anthropic": { "kind": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" },
		"openai": { "kind": "openai-compat", "apiKey": "sk-inline", "baseUrl": "https://proxy.example/v1" },
		"codex": { "kind": "codex" }
	},
	"roles": {
		"smart": { "provider": "anthropic", "model": "claude-opus-4-8", "reasoning": "high" },
		"fast": { "provider": "codex", "model": "gpt-5.5" },
		"orchestrator": { "provider": "openai", "model": "gpt-5.5" }
	}
}`

const env =
	(values: Record<string, string>) =>
	(name: string): string | undefined =>
		values[name]

it.effect('resolves smart (anthropic) with env key, reasoning, and the stamped role', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(configText)
		const models = agentModelsFromConfig(config, { env: env({ ANTHROPIC_API_KEY: 'sk-live' }) })

		const model = yield* models.resolve('smart')
		expect(model.activeModel.providerKind).toBe('anthropic')
		expect(model.activeModel.modelId).toBe('claude-opus-4-8')
		expect(model.activeModel.role).toBe('smart')
		expect(model.activeModel.requestedReasoningLevel).toBe('high')
		expect(model.provider._tag).toBe('anthropic')
	}),
)

it.effect('resolves fast (codex) with no key required', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(configText)
		const models = agentModelsFromConfig(config, { env: env({}) })

		const model = yield* models.resolve('fast')
		expect(model.activeModel.providerKind).toBe('codex')
		expect(model.activeModel.modelId).toBe('gpt-5.5')
		expect(model.activeModel.role).toBe('fast')
	}),
)

it.effect('resolves an explicit orchestrator (openai-compat) with inline key + base url', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(configText)
		const models = agentModelsFromConfig(config, { env: env({}) })

		const model = yield* models.resolve('orchestrator')
		expect(model.activeModel.providerKind).toBe('openai-compatible')
		expect(model.activeModel.role).toBe('orchestrator')
		expect(model.provider._tag).toBe('openai-compatible')
		if (model.provider._tag === 'openai-compatible') {
			expect(model.provider.baseUrl).toBe('https://proxy.example/v1')
		}
	}),
)

it.effect('orchestrator falls back to smart when unbound', () =>
	Effect.gen(function* () {
		const text = `{
			"providers": { "anthropic": { "kind": "anthropic", "apiKeyEnv": "K" } },
			"roles": {
				"smart": { "provider": "anthropic", "model": "claude-opus-4-8" },
				"fast": { "provider": "anthropic", "model": "claude-haiku-4-5" }
			}
		}`
		const config = yield* parseTartConfig(text)
		const models = agentModelsFromConfig(config, { env: env({ K: 'sk' }) })

		const model = yield* models.resolve('orchestrator')
		// Uses smart's binding, but records that it was asked for as the orchestrator.
		expect(model.activeModel.modelId).toBe('claude-opus-4-8')
		expect(model.activeModel.role).toBe('orchestrator')
	}),
)

it.effect('fails with RoleResolutionError when the credential env var is unset', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(configText)
		const models = agentModelsFromConfig(config, { env: env({}) })

		const error = yield* models.resolve('smart').pipe(Effect.flip)
		expect(error._tag).toBe('RoleResolutionError')
		expect(error.role).toBe('smart')
		expect(error.message).toContain('ANTHROPIC_API_KEY')
	}),
)

const catalogEntry = (
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

/** Opus supports the listed efforts; the codex-served gpt model supports no reasoning at all. */
const validationCatalog: ReadonlyArray<ModelCatalogEntry> = [
	catalogEntry({
		providerId: 'anthropic',
		modelId: 'claude-opus-4-8',
		reasoning: true,
		reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
	}),
	catalogEntry({ providerId: 'openai', modelId: 'gpt-5.5', reasoning: false }),
]

const configWithReasoning = (smartReasoning: string, fastReasoning: string): string => `{
	"providers": {
		"anthropic": { "kind": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" },
		"codex": { "kind": "codex" }
	},
	"roles": {
		"smart": { "provider": "anthropic", "model": "claude-opus-4-8", "reasoning": "${smartReasoning}" },
		"fast": { "provider": "codex", "model": "gpt-5.5", "reasoning": "${fastReasoning}" }
	}
}`

it.effect('a reasoning level outside the catalog effort list fails, naming the supported levels', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(configWithReasoning('minimal', 'off'))
		const models = agentModelsFromConfig(config, {
			env: env({ ANTHROPIC_API_KEY: 'sk-live' }),
			catalog: validationCatalog,
		})

		const error = yield* models.resolve('smart').pipe(Effect.flip)
		expect(error._tag).toBe('RoleResolutionError')
		expect(error.role).toBe('smart')
		expect(error.message).toContain('claude-opus-4-8')
		expect(error.message).toContain('"minimal"')
		expect(error.message).toContain('low, medium, high, xhigh, max')
	}),
)

it.effect('a reasoning level on a model whose entry says reasoning: false fails', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(configWithReasoning('off', 'high'))
		const models = agentModelsFromConfig(config, { env: env({}), catalog: validationCatalog })

		const error = yield* models.resolve('fast').pipe(Effect.flip)
		expect(error._tag).toBe('RoleResolutionError')
		expect(error.role).toBe('fast')
		expect(error.message).toContain('does not support reasoning')
		expect(error.message).toContain("use level 'off'")
	}),
)

it.effect('a model the catalog does not know passes through permissively', () =>
	Effect.gen(function* () {
		const text = `{
			"providers": { "anthropic": { "kind": "anthropic", "apiKeyEnv": "K" } },
			"roles": {
				"smart": { "provider": "anthropic", "model": "claude-unreleased-6", "reasoning": "xhigh" },
				"fast": { "provider": "anthropic", "model": "claude-haiku-4-5" }
			}
		}`
		const config = yield* parseTartConfig(text)
		const models = agentModelsFromConfig(config, { env: env({ K: 'sk' }), catalog: validationCatalog })

		const model = yield* models.resolve('smart')
		expect(model.activeModel.requestedReasoningLevel).toBe('xhigh')
	}),
)

it.effect("level 'off' always resolves, even on a reasoning-incapable catalog model", () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(configWithReasoning('off', 'off'))
		const models = agentModelsFromConfig(config, {
			env: env({ ANTHROPIC_API_KEY: 'sk-live' }),
			catalog: validationCatalog,
		})

		const smart = yield* models.resolve('smart')
		expect(smart.activeModel.requestedReasoningLevel).toBe('off')
		const fast = yield* models.resolve('fast')
		expect(fast.activeModel.requestedReasoningLevel).toBe('off')
	}),
)

it.effect('a catalog-listed effort level resolves cleanly', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(configWithReasoning('max', 'off'))
		const models = agentModelsFromConfig(config, {
			env: env({ ANTHROPIC_API_KEY: 'sk-live' }),
			catalog: validationCatalog,
		})

		const model = yield* models.resolve('smart')
		expect(model.activeModel.requestedReasoningLevel).toBe('max')
	}),
)

// --- gpt-5.6 family `max` support against the shipped baked catalog (D23) -----------------------------

const gpt56ConfigText = (smartModel: string): string => `{
	"providers": {
		"codex": { "kind": "codex" },
		"openai": { "kind": "openai-compat", "apiKey": "sk-inline" }
	},
	"roles": {
		"smart": { "provider": "codex", "model": "${smartModel}", "reasoning": "max" },
		"fast": { "provider": "openai", "model": "gpt-5.6-luna", "reasoning": "max" }
	}
}`

it.effect("a codex binding for gpt-5.6-sol with reasoning 'max' resolves against the baked catalog", () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(gpt56ConfigText('gpt-5.6-sol'))
		const models = agentModelsFromConfig(config, { env: env({}), catalog: bakedModelCatalog })

		const model = yield* models.resolve('smart')
		expect(model.activeModel.modelId).toBe('gpt-5.6-sol')
		expect(model.activeModel.requestedReasoningLevel).toBe('max')
	}),
)

it.effect("an openai-compat binding for gpt-5.6-luna with reasoning 'max' resolves against the baked catalog", () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(gpt56ConfigText('gpt-5.6-sol'))
		const models = agentModelsFromConfig(config, { env: env({}), catalog: bakedModelCatalog })

		const model = yield* models.resolve('fast')
		expect(model.activeModel.providerKind).toBe('openai-compatible')
		expect(model.activeModel.modelId).toBe('gpt-5.6-luna')
		expect(model.activeModel.requestedReasoningLevel).toBe('max')
	}),
)

it.effect("gpt-5.5 with reasoning 'max' fails RoleResolutionError naming its supported levels", () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(gpt56ConfigText('gpt-5.5'))
		const models = agentModelsFromConfig(config, { env: env({}), catalog: bakedModelCatalog })

		const error = yield* models.resolve('smart').pipe(Effect.flip)
		expect(error._tag).toBe('RoleResolutionError')
		expect(error.message).toContain('gpt-5.5')
		expect(error.message).toContain('"max"')
		expect(error.message).toContain('none, low, medium, high, xhigh')
	}),
)

// --- per-provider-kind model defaults ------------------------------------------------------------------

const defaultsConfigText = `{
	"providers": {
		"codex": { "kind": "codex" },
		"anthropic": { "kind": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" },
		"openai": { "kind": "openai-compat", "apiKey": "sk-inline" }
	},
	"roles": {
		"smart": { "provider": "codex", "reasoning": "max" },
		"fast": { "provider": "anthropic" },
		"orchestrator": { "provider": "openai" }
	}
}`

it.effect('a codex binding without a model resolves to the gpt-5.6-sol default', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(defaultsConfigText)
		const models = agentModelsFromConfig(config, {
			env: env({ ANTHROPIC_API_KEY: 'sk-live' }),
			catalog: bakedModelCatalog,
		})

		const model = yield* models.resolve('smart')
		expect(model.activeModel.providerKind).toBe('codex')
		expect(model.activeModel.modelId).toBe('gpt-5.6-sol')
		// Catalog validation ran against the defaulted id: sol supports 'max'.
		expect(model.activeModel.requestedReasoningLevel).toBe('max')
	}),
)

it.effect('an anthropic binding without a model resolves to the claude-opus-4-8 default', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(defaultsConfigText)
		const models = agentModelsFromConfig(config, {
			env: env({ ANTHROPIC_API_KEY: 'sk-live' }),
			catalog: bakedModelCatalog,
		})

		const model = yield* models.resolve('fast')
		expect(model.activeModel.providerKind).toBe('anthropic')
		expect(model.activeModel.modelId).toBe('claude-opus-4-8')
	}),
)

it.effect('an openai-compat binding without a model fails with the required-model message', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(defaultsConfigText)
		const models = agentModelsFromConfig(config, {
			env: env({ ANTHROPIC_API_KEY: 'sk-live' }),
			catalog: bakedModelCatalog,
		})

		const error = yield* models.resolve('orchestrator').pipe(Effect.flip)
		expect(error._tag).toBe('RoleResolutionError')
		expect(error.role).toBe('orchestrator')
		expect(error.message).toContain('without a model')
		expect(error.message).toContain('codex → gpt-5.6-sol')
		expect(error.message).toContain('anthropic → claude-opus-4-8')
		expect(error.message).toContain('required for openai-compat')
	}),
)
