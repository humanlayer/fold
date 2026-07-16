import { expect, it } from '@effect/vitest'
import type { ModelCatalogEntry } from '@humanlayer/fold-core'
import { Effect } from 'effect'

import { describeModelConfiguration, parseFoldConfig, resolveConfiguredModelSelection } from '../../src/index'

const configText = `{
	"providers": {
		"claude": { "kind": "anthropic", "apiKey": "super-secret" },
		"codex": { "kind": "codex" }
	},
	"roles": {
		"smart": { "provider": "claude", "model": "default-smart" },
		"fast": { "provider": "codex", "model": "default-fast" }
	},
	"profiles": {
		"named": {
			"smart": { "provider": "codex", "model": "profile-smart" },
			"fast": { "provider": "codex", "model": "profile-fast" },
			"orchestrator": { "provider": "codex", "model": "profile-orchestrator" },
			"mode": "rlm"
		}
	}
}`

const catalog: ReadonlyArray<ModelCatalogEntry> = [
	{
		providerId: 'codex',
		modelId: 'catalog-only',
		name: null,
		contextWindow: 100_000,
		maxInputTokens: null,
		maxOutputTokens: 10_000,
		reasoning: true,
		reasoningEfforts: null,
		vision: false,
		toolCall: true,
		pricing: null,
	},
]

const catalogEntry = (providerId: string, modelId: string): ModelCatalogEntry => {
	const entry = catalog[0]
	if (entry === undefined) throw new Error('Expected catalog fixture')
	return { ...entry, providerId, modelId }
}

it.effect('resolves default and named profiles', () =>
	Effect.gen(function* () {
		const config = yield* parseFoldConfig(configText)
		const defaultModels = yield* resolveConfiguredModelSelection(config, { _tag: 'profile', profile: 'default' })
		const namedModels = yield* resolveConfiguredModelSelection(config, { _tag: 'profile', profile: 'named' })
		const namedInCurrentRlmMode = yield* resolveConfiguredModelSelection(
			config,
			{ _tag: 'profile', profile: 'named' },
			'rlm',
		)

		expect(defaultModels.root.activeModel.modelId).toBe('default-smart')
		expect(defaultModels.fast.activeModel.modelId).toBe('default-fast')
		expect(namedModels.smart.activeModel.modelId).toBe('profile-smart')
		expect(namedModels.fast.activeModel.modelId).toBe('profile-fast')
		expect(namedInCurrentRlmMode.root.activeModel.modelId).toBe('profile-orchestrator')
		expect(namedInCurrentRlmMode.smart.activeModel.modelId).toBe('profile-smart')
	}),
)

it.effect('applies provider-specific role defaults around the directly selected root model', () =>
	Effect.gen(function* () {
		const config = yield* parseFoldConfig(configText)
		const direct = { _tag: 'direct' as const, provider: 'codex', model: 'chosen' }
		const normal = yield* resolveConfiguredModelSelection(config, direct)
		const rlm = yield* resolveConfiguredModelSelection(config, direct, 'rlm')

		expect(normal.root.activeModel.modelId).toBe('chosen')
		expect(normal.root.activeModel.role).toBe('smart')
		expect(normal.smart.activeModel.modelId).toBe('chosen')
		expect(normal.fast.activeModel).toMatchObject({ providerId: 'codex', modelId: 'gpt-5.6-luna' })
		expect(normal.orchestrator.activeModel).toMatchObject({ providerId: 'codex', modelId: 'gpt-5.6-sol' })
		expect(rlm.root.activeModel.modelId).toBe('chosen')
		expect(rlm.root.activeModel.role).toBe('orchestrator')
		expect(rlm.smart.activeModel).toMatchObject({ providerId: 'codex', modelId: 'gpt-5.6-terra' })
		expect(rlm.fast.activeModel).toMatchObject({ providerId: 'codex', modelId: 'gpt-5.6-luna' })
	}),
)

it.effect('a direct Codex choice does not resolve unrelated Anthropic role credentials', () =>
	Effect.gen(function* () {
		const config = yield* parseFoldConfig(`{
			"providers": {
				"anthropic": { "kind": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" },
				"codex": { "kind": "codex" }
			},
			"roles": {
				"smart": { "provider": "anthropic" },
				"fast": { "provider": "anthropic" },
				"orchestrator": { "provider": "anthropic" }
			}
		}`)

		const models = yield* resolveConfiguredModelSelection(
			config,
			{ _tag: 'direct', provider: 'codex', model: 'gpt-5.6-sol' },
			'default',
			{ env: () => undefined },
		)

		expect(
			[models.root, models.smart, models.fast, models.orchestrator].every(
				(model) => model.activeModel.providerId === 'codex',
			),
		).toBe(true)
	}),
)

it.effect('uses Anthropic defaults for a direct Anthropic choice', () =>
	Effect.gen(function* () {
		const config = yield* parseFoldConfig(configText)
		const models = yield* resolveConfiguredModelSelection(config, {
			_tag: 'direct',
			provider: 'claude',
			model: 'claude-selected',
		})

		expect(models.smart.activeModel.modelId).toBe('claude-selected')
		expect(models.orchestrator.activeModel.modelId).toBe('claude-opus-4-8')
		expect(models.fast.activeModel.modelId).toBe('claude-sonnet-5')
		expect(
			[models.smart, models.fast, models.orchestrator].every(
				(model) => model.activeModel.providerId === 'claude',
			),
		).toBe(true)
	}),
)

it.effect('rejects an unknown profile', () =>
	Effect.gen(function* () {
		const config = yield* parseFoldConfig(configText)
		const error = yield* resolveConfiguredModelSelection(config, { _tag: 'profile', profile: 'missing' }).pipe(
			Effect.flip,
		)
		expect(error.message).toContain('unknown model profile "missing"')
	}),
)

it.effect('describes profiles, credentials, and merged model candidates without secrets', () =>
	Effect.gen(function* () {
		const config = yield* parseFoldConfig(configText)
		const description = describeModelConfiguration(config, catalog)

		expect(description.profiles).toContainEqual({ name: 'named', mode: 'rlm' })
		expect(description.providers.find(({ name }) => name === 'claude')?.credentialPresent).toBe(true)
		expect(description.providers.find(({ name }) => name === 'codex')?.models).toEqual([
			'catalog-only',
			'default-fast',
			'gpt-5.6-sol',
			'profile-fast',
			'profile-orchestrator',
			'profile-smart',
		])
		expect(JSON.stringify(description)).not.toContain('super-secret')
		expect(description).not.toHaveProperty('config')
	}),
)

it.effect('always exposes Grok Build for an OpenCode provider without catalog data', () =>
	Effect.gen(function* () {
		const config = yield* parseFoldConfig(`{
			"providers": { "zen": { "kind": "opencode" } },
			"roles": { "smart": { "provider": "zen" }, "fast": { "provider": "zen" } }
		}`)
		expect(describeModelConfiguration(config).providers[0]?.models).toEqual(['gpt-5.6-sol', 'grok-build-0.1'])
	}),
)

it.effect('maps catalog provider ids through configured provider aliases', () =>
	Effect.gen(function* () {
		const config = yield* parseFoldConfig(`{
			"providers": {
				"claude-alias": { "kind": "anthropic", "apiKey": "x" },
				"codex-alias": { "kind": "codex" },
				"proxy": { "kind": "openai-compat", "baseUrl": "https://example.test", "apiKey": "x" }
			},
			"roles": {
				"smart": { "provider": "claude-alias", "model": "claude" },
				"fast": { "provider": "proxy", "model": "gpt" }
			}
		}`)
		const description = describeModelConfiguration(config, [
			catalogEntry('anthropic', 'anthropic-catalog'),
			catalogEntry('openai', 'openai-catalog'),
			catalogEntry('proxy', 'proxy-catalog'),
		])

		expect(description.providers.find(({ name }) => name === 'claude-alias')?.models).toContain('anthropic-catalog')
		expect(description.providers.find(({ name }) => name === 'codex-alias')?.models).toContain('openai-catalog')
		expect(description.providers.find(({ name }) => name === 'proxy')?.models).toEqual(
			expect.arrayContaining(['openai-catalog', 'proxy-catalog']),
		)
	}),
)

it.effect('provides OAuth defaults when the external catalog is unavailable', () =>
	Effect.gen(function* () {
		const config = yield* parseFoldConfig(`{
			"providers": { "zen": { "kind": "opencode" }, "grok": { "kind": "xai" } },
			"roles": { "smart": { "provider": "zen" }, "fast": { "provider": "grok" } }
		}`)
		const description = describeModelConfiguration(config, [])
		expect(description.providers.find(({ name }) => name === 'zen')).toMatchObject({
			credentialPresent: null,
			models: ['gpt-5.6-sol', 'grok-build-0.1'],
		})
		expect(description.providers.find(({ name }) => name === 'grok')).toMatchObject({
			credentialPresent: null,
			models: ['grok-4.5'],
		})
	}),
)

it.effect('only exposes Grok 4.5 for xAI providers', () =>
	Effect.gen(function* () {
		const config = yield* parseFoldConfig(`{
			"providers": { "grok": { "kind": "xai", "configuredModels": ["grok-3", "grok-4"] } },
			"roles": {
				"smart": { "provider": "grok", "model": "grok-4" },
				"fast": { "provider": "grok", "model": "grok-3" }
			}
		}`)
		const description = describeModelConfiguration(config, [catalogEntry('xai', 'grok-2')])
		expect(description.providers[0]?.models).toEqual(['grok-4.5'])
	}),
)
