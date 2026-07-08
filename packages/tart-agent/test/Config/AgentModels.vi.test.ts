/**
 * AgentModels role-resolution tests (D25): a config role resolves to a runnable TartModel descriptor
 * for each provider kind (anthropic / openai-compat / codex), `orchestrator` falls back to `smart` when
 * unbound, the requested role is stamped on the model snapshot, reasoning flows through, and a missing
 * credential env var is a typed RoleResolutionError. Descriptors are plain data (codex's provider layer
 * is lazy), so nothing here touches the network.
 */
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { agentModelsFromConfig, parseTartConfig } from '../../src/index'

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
