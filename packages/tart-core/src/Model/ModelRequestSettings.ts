/**
 * This file applies the active model and reasoning settings to outgoing model requests. The agent loop
 * wraps each model call with `ModelRequestSettings.wrap`, which provides the provider's per-request
 * config service (OpenAI/Anthropic `Config` via `withConfigOverride`) around the request effect. The
 * projected reasoning level binds reasoning/thinking on every provider, and on openai-compatible/codex
 * the projected model id also binds the request `model` - so `thinking-change` and same-provider
 * `model-change` entries take effect on the very next turn without rebuilding any layer (D23).
 */
import { AnthropicLanguageModel } from '@effect/ai-anthropic'
import { OpenAiLanguageModel } from '@effect/ai-openai'
import { Context, Layer } from 'effect'
import type { Effect } from 'effect'

import type {
	ActiveModel,
	AnthropicThinkingSetting,
	CodexReasoningSetting,
	OpenAiReasoningSetting,
	ReasoningLevel,
} from '../EventLog/Schemas'

/**
 * Map one reasoning level onto the OpenAI effort scale. `off` disables reasoning config entirely
 * (provider default applies); `max` clamps to `xhigh` (D23 clamp precedent - pi clamps unsupported
 * levels down). Per-model level validation arrives with the ModelCatalog (D23).
 */
export const resolveOpenAiReasoning = (level: ReasoningLevel): OpenAiReasoningSetting =>
	level === 'off' ? { _tag: 'disabled' } : { _tag: 'effort', effort: level === 'max' ? 'xhigh' : level }

/** Map one reasoning level onto codex reasoning; codex always requests auto summaries (D23). */
export const resolveCodexReasoning = (level: ReasoningLevel): CodexReasoningSetting =>
	level === 'off'
		? { _tag: 'disabled' }
		: { _tag: 'effort', effort: level === 'max' ? 'xhigh' : level, summary: 'auto' }

/**
 * Claude models that support adaptive thinking (`thinking: { type: "adaptive" }`): Opus 4.6+,
 * Sonnet 4.6+, and the Fable/Mythos tier. On these models `budget_tokens` is deprecated (4.6) or
 * rejected with a 400 (4.7+/Sonnet 5/Fable), so adaptive is the default. Interim pattern table
 * until the ModelCatalog owns per-model capability data (D23).
 */
export const adaptiveThinkingModelPatterns: ReadonlyArray<RegExp> = [
	/fable/,
	/mythos/,
	/opus-4-[6-9]/,
	/sonnet-4-6/,
	/sonnet-5/,
]

/** True when the claude model id supports adaptive thinking. */
export const supportsAdaptiveThinking = (modelId: string): boolean => {
	const id = modelId.toLowerCase()

	return adaptiveThinkingModelPatterns.some((pattern) => pattern.test(id))
}

/**
 * Default per-level thinking budgets for pre-adaptive anthropic models (Haiku 4.5, Sonnet 4.5, and
 * older) - pi's table (`simple-options.ts`), with `xhigh`/`max` clamped to the `high` budget until
 * ModelCatalog-driven per-model budgets and max_tokens fitting land (D23). The provider defaults
 * `max_tokens` to the model's max output, which comfortably exceeds these budgets.
 */
export const defaultAnthropicThinkingBudgets: Record<Exclude<ReasoningLevel, 'off'>, number> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 16384,
	max: 16384,
}

/**
 * Map one reasoning level onto an anthropic thinking setting for the given model: `off` disables
 * thinking; adaptive-capable models (Opus 4.6+, Sonnet 4.6+, Fable/Mythos) get adaptive thinking
 * with depth steered via effort at request time; pre-adaptive models get pi's budget table.
 */
export const resolveAnthropicThinking = (level: ReasoningLevel, modelId: string): AnthropicThinkingSetting =>
	level === 'off'
		? { _tag: 'disabled' }
		: supportsAdaptiveThinking(modelId)
			? { _tag: 'adaptive' }
			: { _tag: 'budget', budgetTokens: defaultAnthropicThinkingBudgets[level] }

/**
 * Map one reasoning level onto the anthropic per-request effort knob used alongside adaptive
 * thinking. The vendored provider `Config` currently exposes only `low | medium | high`, so
 * `minimal` maps to `low` and `xhigh`/`max` clamp to `high` until the SDK exposes the full scale.
 */
export const anthropicEffortForLevel = (level: ReasoningLevel): 'low' | 'medium' | 'high' => {
	switch (level) {
		case 'off':
		case 'minimal':
		case 'low':
			return 'low'
		case 'medium':
			return 'medium'
		case 'high':
		case 'xhigh':
		case 'max':
			return 'high'
	}
}

/** Input for wrapping one model request: the projected active model and reasoning level. */
export type WrapModelRequestInput = {
	readonly model: ActiveModel | null
	readonly reasoningLevel: ReasoningLevel | null
}

/**
 * Request-time model settings application.
 *
 * `wrap` returns a combinator that provides provider-specific per-request configuration around one
 * model request effect: the effective reasoning setting binds when enabled, and on openai-compatible
 * and codex models the projected model id also binds the request `model`.
 */
export type ModelRequestSettingsService = {
	readonly wrap: (input: WrapModelRequestInput) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/** ModelRequestSettings service tag. */
export class ModelRequestSettings extends Context.Service<ModelRequestSettings, ModelRequestSettingsService>()(
	'tart/ModelRequestSettings',
) {}

const identity = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => self

/**
 * Live ModelRequestSettings. The effective setting is the model's stored resolved setting while the
 * projected level still equals the level it was minted for, otherwise re-derived from the projected
 * level (the `thinking-change` path). openai-compatible and codex apply through the OpenAI provider's
 * per-request `Config`; anthropic applies adaptive thinking + effort (or a thinking budget on
 * pre-adaptive models) through the Anthropic provider's `Config`.
 */
export const liveModelRequestSettingsLayer: Layer.Layer<ModelRequestSettings> = Layer.succeed(ModelRequestSettings, {
	wrap: ({ model, reasoningLevel }) => {
		if (model === null) return identity

		const level = reasoningLevel ?? model.requestedReasoningLevel

		switch (model.providerKind) {
			case 'openai-compatible': {
				const setting =
					level === model.requestedReasoningLevel ? model.reasoning : resolveOpenAiReasoning(level)

				return (self) =>
					OpenAiLanguageModel.withConfigOverride(self, {
						model: model.modelId,
						...(setting._tag === 'disabled' ? {} : { reasoning: { effort: setting.effort } }),
					})
			}

			case 'codex': {
				const setting = level === model.requestedReasoningLevel ? model.reasoning : resolveCodexReasoning(level)

				return (self) =>
					OpenAiLanguageModel.withConfigOverride(self, {
						model: model.modelId,
						...(setting._tag === 'disabled'
							? {}
							: { reasoning: { effort: setting.effort, summary: setting.summary } }),
					})
			}

			case 'anthropic': {
				const setting =
					level === model.requestedReasoningLevel
						? model.thinking
						: resolveAnthropicThinking(level, model.modelId)

				// Unlike the OpenAI config, the anthropic generated schema types `model` as a strict literal
				// union, so the projected model id cannot bind per-request; anthropic model selection stays at
				// layer construction until the AgentModels layer seam lands (D15). Tools opt out of strict
				// structured-output mode at definition time; do not pass the provider's `strictJsonSchema`
				// config helper here, because this beta provider accidentally forwards it into the API payload.
				switch (setting._tag) {
					case 'disabled':
						return identity
					case 'adaptive':
						return (self) =>
							AnthropicLanguageModel.withConfigOverride(self, {
								thinking: { type: 'adaptive' },
								output_config: { effort: anthropicEffortForLevel(level) },
							})
					case 'budget':
						return (self) =>
							AnthropicLanguageModel.withConfigOverride(self, {
								thinking: { type: 'enabled', budget_tokens: setting.budgetTokens },
							})
				}
			}
		}
	},
})
