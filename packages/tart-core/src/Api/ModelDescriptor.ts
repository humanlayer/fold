/**
 * This file defines model descriptors for the public API: plain-data descriptions of which provider,
 * model, credentials, and reasoning level an agent should run on. Constructors return data only - the
 * Session composition root lowers a descriptor to a LanguageModel context when it builds or switches a
 * runtime, so no client or provider layer wiring appears in caller code (D15's provisioning seam).
 */
import { Redacted } from 'effect'
import type { Effect, Scope } from 'effect'
import type { LanguageModel } from 'effect/unstable/ai'

import type { ActiveModel, ReasoningLevel } from '../EventLog/Schemas'
import { resolveAnthropicThinking, resolveOpenAiReasoning } from '../Model/ModelRequestSettings'

/**
 * How the LanguageModel service for a model is obtained: a known provider connection (credentials and
 * base URL as data), or a custom service-implementation Effect - the extension seam for scripted test
 * models and future provider packages (layers are never accepted as domain-API arguments).
 */
export type TartModelProvider =
	| {
			readonly _tag: 'openai-compatible'
			readonly apiKey: Redacted.Redacted<string>
			readonly baseUrl: string | null
	  }
	| {
			readonly _tag: 'anthropic'
			readonly apiKey: Redacted.Redacted<string>
			readonly baseUrl: string | null
	  }
	| {
			readonly _tag: 'custom'
			readonly make: Effect.Effect<LanguageModel.Service, never, Scope.Scope>
	  }

/**
 * One model an agent can run on: the resolved ActiveModel snapshot recorded in the durable log plus the
 * provider connection used to reach it. Built with {@link openaiModel}, {@link anthropicModel}, or
 * {@link customModel}; consumed by `startSession` and `TartSession.switchModel`.
 */
export type TartModel = {
	readonly activeModel: ActiveModel
	readonly provider: TartModelProvider
}

const redact = (apiKey: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
	typeof apiKey === 'string' ? Redacted.make(apiKey) : apiKey

/** Options for {@link openaiModel} and {@link anthropicModel}. */
export type ProviderModelOptions = {
	/** Provider model id, for example `gpt-5.5` or `claude-opus-4-8`. */
	readonly model: string
	readonly apiKey: string | Redacted.Redacted<string>
	/** Override the provider base URL, for example to reach an API-compatible proxy. */
	readonly baseUrl?: string
	/** Reasoning level for requests. Defaults to `off`, which leaves the provider default untouched. */
	readonly reasoning?: ReasoningLevel
	/** Configured provider profile name recorded in the log. Defaults to the provider kind. */
	readonly providerId?: string
}

/** Describe a model served by any OpenAI-compatible endpoint. */
export const openaiModel = (options: ProviderModelOptions): TartModel => {
	const level = options.reasoning ?? 'off'

	return {
		activeModel: {
			providerId: options.providerId ?? 'openai',
			providerKind: 'openai-compatible',
			modelId: options.model,
			role: null,
			requestedReasoningLevel: level,
			reasoning: resolveOpenAiReasoning(level),
		},
		provider: { _tag: 'openai-compatible', apiKey: redact(options.apiKey), baseUrl: options.baseUrl ?? null },
	}
}

/** Describe a model served by any Anthropic-compatible endpoint. */
export const anthropicModel = (options: ProviderModelOptions): TartModel => {
	const level = options.reasoning ?? 'off'

	return {
		activeModel: {
			providerId: options.providerId ?? 'anthropic',
			providerKind: 'anthropic',
			modelId: options.model,
			role: null,
			requestedReasoningLevel: level,
			thinking: resolveAnthropicThinking(level, options.model),
		},
		provider: { _tag: 'anthropic', apiKey: redact(options.apiKey), baseUrl: options.baseUrl ?? null },
	}
}

/** Options for {@link customModel}. */
export type CustomModelOptions = {
	/** The resolved model snapshot recorded in the durable log. */
	readonly activeModel: ActiveModel
	/** Builds the LanguageModel service implementation - the escape hatch for tests and custom providers. */
	readonly make: Effect.Effect<LanguageModel.Service, never, Scope.Scope>
}

/** Describe a model backed by a caller-supplied LanguageModel implementation. */
export const customModel = (options: CustomModelOptions): TartModel => ({
	activeModel: options.activeModel,
	provider: { _tag: 'custom', make: options.make },
})
