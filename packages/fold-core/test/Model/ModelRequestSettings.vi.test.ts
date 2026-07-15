import { AnthropicLanguageModel } from '@effect/ai-anthropic'
import { OpenAiLanguageModel } from '@effect/ai-openai'
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import {
	defaultAnthropicThinkingBudgets,
	liveModelRequestSettingsLayer,
	ModelRequestSettings,
	resolveAnthropicThinking,
	resolveCodexReasoning,
	resolveOpenAiReasoning,
	supportsAdaptiveThinking,
	type ActiveModel,
	type WrapModelRequestInput,
} from '../../src/index'

const openAiMediumModel: ActiveModel = {
	providerId: 'openai',
	providerKind: 'openai-compatible',
	modelId: 'gpt-5.5',
	role: null,
	requestedReasoningLevel: 'medium',
	reasoning: { _tag: 'effort', effort: 'medium' },
}

const openAiOffModel: ActiveModel = {
	providerId: 'openai',
	providerKind: 'openai-compatible',
	modelId: 'gpt-5.5',
	role: null,
	requestedReasoningLevel: 'off',
	reasoning: { _tag: 'disabled' },
}

const codexModel: ActiveModel = {
	providerId: 'codex',
	providerKind: 'codex',
	modelId: 'gpt-5.5',
	role: null,
	requestedReasoningLevel: 'high',
	reasoning: { _tag: 'effort', effort: 'high', summary: 'auto' },
}

const codexMaxModel: ActiveModel = {
	providerId: 'codex',
	providerKind: 'codex',
	modelId: 'gpt-5.6-sol',
	role: null,
	requestedReasoningLevel: 'max',
	reasoning: { _tag: 'effort', effort: 'max', summary: 'auto' },
}

const claudeAdaptiveModel: ActiveModel = {
	providerId: 'anthropic',
	providerKind: 'anthropic',
	modelId: 'claude-opus-4-8',
	role: null,
	requestedReasoningLevel: 'high',
	thinking: { _tag: 'adaptive' },
}

const claudeOffModel: ActiveModel = {
	providerId: 'anthropic',
	providerKind: 'anthropic',
	modelId: 'claude-opus-4-8',
	role: null,
	requestedReasoningLevel: 'off',
	thinking: { _tag: 'disabled' },
}

const haikuBudgetModel: ActiveModel = {
	providerId: 'anthropic',
	providerKind: 'anthropic',
	modelId: 'claude-haiku-4-5',
	role: null,
	requestedReasoningLevel: 'medium',
	thinking: { _tag: 'budget', budgetTokens: 8192 },
}

it('resolves reasoning levels onto the OpenAI effort scale with off disabled and max passed through', () => {
	expect(resolveOpenAiReasoning('off')).toEqual({ _tag: 'disabled' })
	expect(resolveOpenAiReasoning('low')).toEqual({ _tag: 'effort', effort: 'low' })
	expect(resolveOpenAiReasoning('max')).toEqual({ _tag: 'effort', effort: 'max' })
	expect(resolveCodexReasoning('medium')).toEqual({ _tag: 'effort', effort: 'medium', summary: 'auto' })
	expect(resolveCodexReasoning('max')).toEqual({ _tag: 'effort', effort: 'max', summary: 'auto' })
	expect(resolveCodexReasoning('off')).toEqual({ _tag: 'disabled' })
})

it('resolves anthropic thinking per model: adaptive on capable models, budgets otherwise', () => {
	expect(supportsAdaptiveThinking('claude-opus-4-8')).toBe(true)
	expect(supportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true)
	expect(supportsAdaptiveThinking('claude-fable-5')).toBe(true)
	expect(supportsAdaptiveThinking('claude-haiku-4-5')).toBe(false)
	expect(supportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false)

	expect(resolveAnthropicThinking('off', 'claude-opus-4-8')).toEqual({ _tag: 'disabled' })
	expect(resolveAnthropicThinking('high', 'claude-opus-4-8')).toEqual({ _tag: 'adaptive' })
	expect(resolveAnthropicThinking('minimal', 'claude-haiku-4-5')).toEqual({ _tag: 'budget', budgetTokens: 1024 })
	expect(resolveAnthropicThinking('max', 'claude-haiku-4-5')).toEqual({
		_tag: 'budget',
		budgetTokens: defaultAnthropicThinkingBudgets.high,
	})
})

/** Run probes under `wrap`, returning the provider Configs the providers would see, or null. */
const observedConfigs = (input: WrapModelRequestInput) =>
	Effect.gen(function* () {
		const settings = yield* ModelRequestSettings
		const openai = yield* settings.wrap(input)(Effect.serviceOption(OpenAiLanguageModel.Config))
		const anthropic = yield* settings.wrap(input)(Effect.serviceOption(AnthropicLanguageModel.Config))

		return {
			openai: openai._tag === 'Some' ? openai.value : null,
			anthropic: anthropic._tag === 'Some' ? anthropic.value : null,
		}
	}).pipe(Effect.provide(liveModelRequestSettingsLayer))

it.effect('binds the projected model id and stored reasoning when the level matches the minted level', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: openAiMediumModel, reasoningLevel: 'medium' })

		expect(configs.openai).toEqual({ model: 'gpt-5.5', reasoning: { effort: 'medium' } })
		expect(configs.anthropic).toBeNull()
	}),
)

it.effect('re-derives the setting from the projected level after a thinking-change', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: openAiMediumModel, reasoningLevel: 'high' })

		expect(configs.openai?.reasoning).toEqual({ effort: 'high' })
	}),
)

it.effect('passes max through to the provider config when re-deriving', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: openAiMediumModel, reasoningLevel: 'max' })

		expect(configs.openai).toEqual({ model: 'gpt-5.5', reasoning: { effort: 'max' } })
	}),
)

it.effect('binds the model but no reasoning when the level is off', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: openAiOffModel, reasoningLevel: 'off' })

		expect(configs.openai).toEqual({ model: 'gpt-5.5' })
	}),
)

it.effect('provides codex reasoning with auto summaries', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: codexModel, reasoningLevel: 'high' })

		expect(configs.openai).toEqual({
			model: 'gpt-5.5',
			reasoning: { effort: 'high', summary: 'auto' },
		})
	}),
)

it.effect('carries max effort with auto summaries into the codex provider config', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: codexMaxModel, reasoningLevel: 'max' })

		expect(configs.openai).toEqual({
			model: 'gpt-5.6-sol',
			reasoning: { effort: 'max', summary: 'auto' },
		})
	}),
)

it.effect('provides adaptive thinking with effort for adaptive-capable claude models', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: claudeAdaptiveModel, reasoningLevel: 'high' })

		expect(configs.anthropic).toEqual({
			thinking: { type: 'adaptive' },
			output_config: { effort: 'high' },
		})
		expect(configs.openai).toBeNull()
	}),
)

it.effect('rebinds adaptive effort from the projected level after a thinking-change', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: claudeAdaptiveModel, reasoningLevel: 'medium' })

		expect(configs.anthropic).toEqual({
			thinking: { type: 'adaptive' },
			output_config: { effort: 'medium' },
		})
	}),
)

it.effect('clamps xhigh/max onto the effort scale the provider config exposes', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: claudeAdaptiveModel, reasoningLevel: 'max' })

		expect(configs.anthropic?.output_config).toEqual({ effort: 'high' })
	}),
)

it.effect('provides a thinking budget for pre-adaptive claude models', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: haikuBudgetModel, reasoningLevel: 'medium' })

		expect(configs.anthropic).toEqual({ thinking: { type: 'enabled', budget_tokens: 8192 } })
	}),
)

it.effect('re-derives the budget from the projected level on pre-adaptive claude models', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: haikuBudgetModel, reasoningLevel: 'high' })

		expect(configs.anthropic).toEqual({ thinking: { type: 'enabled', budget_tokens: 16384 } })
	}),
)

it.effect('provides nothing for anthropic when the level is off', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: claudeOffModel, reasoningLevel: 'off' })

		expect(configs.anthropic).toBeNull()
	}),
)

it.effect('is identity when no model is active', () =>
	Effect.gen(function* () {
		const configs = yield* observedConfigs({ model: null, reasoningLevel: 'high' })

		expect(configs.openai).toBeNull()
		expect(configs.anthropic).toBeNull()
	}),
)
