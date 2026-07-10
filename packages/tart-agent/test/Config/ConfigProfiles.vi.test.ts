/**
 * Named-profile config tests: the `profiles` block decodes (roles + optional pinned mode), profile
 * bindings participate in the providers cross-reference check, `ProfileModeName` stays in sync with
 * the mode registry, and the SHIPPED starter profiles (ultraclaude / ultracodex) are exactly the
 * everything-max RLM presets - validated against the baked catalog so `reasoning: "max"` is known
 * good for all six models.
 */
import { expect, it } from '@effect/vitest'
import { lookupCatalogEntry, type ActiveModel } from '@humanlayer/tart-core'
import { Effect, Schema } from 'effect'

import {
	agentModelsFromConfig,
	bakedModelCatalog,
	parseTartConfig,
	ProfileModeName,
	starterConfigJsonc,
	TART_MODE_NAMES,
	type ProfileConfig,
	type RoleBinding,
	type TartConfig,
} from '../../src/index'

it.effect('decodes a profiles block with role bindings and a pinned mode', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(`{
			"providers": { "openai": { "kind": "openai-compat", "apiKey": "sk-x" } },
			"roles": {
				"smart": { "provider": "openai", "model": "gpt-a" },
				"fast": { "provider": "openai", "model": "gpt-b" }
			},
			"profiles": {
				"turbo": {
					"mode": "rlm",
					"smart": { "provider": "openai", "model": "gpt-c", "reasoning": "high" },
					"fast": { "provider": "openai", "model": "gpt-d" }
				}
			}
		}`)

		const turbo = config.profiles?.['turbo']
		expect(turbo?.mode).toBe('rlm')
		expect(turbo?.smart.model).toBe('gpt-c')
		expect(turbo?.smart.reasoning).toBe('high')
		expect(turbo?.orchestrator).toBeUndefined()
	}),
)

it.effect('rejects a profile binding that references an undeclared provider', () =>
	Effect.gen(function* () {
		const error = yield* parseTartConfig(`{
			"providers": { "openai": { "kind": "openai-compat", "apiKey": "sk-x" } },
			"roles": {
				"smart": { "provider": "openai", "model": "gpt-a" },
				"fast": { "provider": "openai", "model": "gpt-b" }
			},
			"profiles": {
				"broken": {
					"smart": { "provider": "nope", "model": "gpt-c" },
					"fast": { "provider": "openai", "model": "gpt-d" }
				}
			}
		}`).pipe(Effect.flip)

		expect(error._tag).toBe('ConfigDecodeError')
		expect(error.message).toContain('nope')
	}),
)

it('ProfileModeName stays in sync with the mode registry', () => {
	// Every registered mode name must be expressible in a profile (catches a new mode added to
	// TART_MODE_NAMES without widening the config literal copy).
	for (const name of TART_MODE_NAMES) {
		expect(Schema.is(ProfileModeName)(name), name).toBe(true)
	}
	expect(Schema.is(ProfileModeName)('not-a-mode')).toBe(false)
})

const syntheticOpenAiModel = (modelId: string): ActiveModel => ({
	providerId: 'openai',
	providerKind: 'openai-compatible',
	modelId,
	role: null,
	requestedReasoningLevel: 'off',
	reasoning: { _tag: 'disabled' },
})

const profileBindings = (profile: ProfileConfig): ReadonlyArray<RoleBinding> => [
	profile.smart,
	profile.fast,
	...(profile.orchestrator === undefined ? [] : [profile.orchestrator]),
]

/** Substitute one profile's roles as the config's active roles (what --profile does at launch). */
const withProfileRoles = (config: TartConfig, profile: ProfileConfig): TartConfig => ({
	...config,
	roles: {
		smart: profile.smart,
		fast: profile.fast,
		...(profile.orchestrator === undefined ? {} : { orchestrator: profile.orchestrator }),
	},
})

it.effect('the starter config ships the ultraclaude, powerclaude, and ultracodex everything-max RLM presets', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(starterConfigJsonc())
		const ultraclaude = config.profiles?.['ultraclaude']
		const powerclaude = config.profiles?.['powerclaude']
		const ultracodex = config.profiles?.['ultracodex']

		expect(ultraclaude?.mode).toBe('rlm')
		expect(ultraclaude?.orchestrator?.model).toBe('claude-fable-5')
		expect(ultraclaude?.smart.model).toBe('claude-opus-4-8')
		expect(ultraclaude?.fast.model).toBe('claude-sonnet-5')

		// powerclaude = ultraclaude with the orchestrator on opus-4-8 instead of fable-5.
		expect(powerclaude?.mode).toBe('rlm')
		expect(powerclaude?.orchestrator?.model).toBe('claude-opus-4-8')
		expect(powerclaude?.smart.model).toBe('claude-opus-4-8')
		expect(powerclaude?.fast.model).toBe('claude-sonnet-5')

		expect(ultracodex?.mode).toBe('rlm')
		expect(ultracodex?.orchestrator?.model).toBe('gpt-5.6-sol')
		expect(ultracodex?.smart.model).toBe('gpt-5.6-terra')
		expect(ultracodex?.fast.model).toBe('gpt-5.6-luna')

		// Every binding runs at max, and the baked catalog confirms every pinned model supports it -
		// this is what makes `reasoning: "max"` a known-good shipped default rather than a hope.
		for (const profile of [ultraclaude, powerclaude, ultracodex]) {
			expect(profile).toBeDefined()
			if (profile === undefined) continue
			for (const binding of profileBindings(profile)) {
				expect(binding.reasoning, binding.model).toBe('max')
				const model = binding.model
				expect(model).toBeDefined()
				if (model === undefined) continue
				const entry = lookupCatalogEntry(bakedModelCatalog, syntheticOpenAiModel(model))
				expect(entry?.reasoningEfforts, model).toContain('max')
			}
		}
	}),
)

it.effect('the shipped ultracodex profile resolves end to end with max reasoning (codex needs no key)', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(starterConfigJsonc())
		const ultracodex = config.profiles?.['ultracodex']
		expect(ultracodex).toBeDefined()
		if (ultracodex === undefined) return

		const models = agentModelsFromConfig(withProfileRoles(config, ultracodex), { catalog: bakedModelCatalog })
		const orchestrator = yield* models.resolve('orchestrator')
		const smart = yield* models.resolve('smart')
		const fast = yield* models.resolve('fast')

		expect(orchestrator.activeModel.modelId).toBe('gpt-5.6-sol')
		expect(smart.activeModel.modelId).toBe('gpt-5.6-terra')
		expect(fast.activeModel.modelId).toBe('gpt-5.6-luna')
		expect(orchestrator.activeModel.requestedReasoningLevel).toBe('max')
	}),
)

it.effect('the shipped ultraclaude profile resolves end to end with max reasoning', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(starterConfigJsonc())
		const ultraclaude = config.profiles?.['ultraclaude']
		expect(ultraclaude).toBeDefined()
		if (ultraclaude === undefined) return

		const models = agentModelsFromConfig(withProfileRoles(config, ultraclaude), {
			catalog: bakedModelCatalog,
			env: (name) => (name === 'ANTHROPIC_API_KEY' ? 'sk-test' : undefined),
		})
		const orchestrator = yield* models.resolve('orchestrator')
		const fast = yield* models.resolve('fast')

		expect(orchestrator.activeModel.modelId).toBe('claude-fable-5')
		expect(orchestrator.activeModel.requestedReasoningLevel).toBe('max')
		expect(fast.activeModel.modelId).toBe('claude-sonnet-5')
	}),
)
