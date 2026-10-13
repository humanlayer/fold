/**
 * This file defines model descriptors for the public API: plain-data descriptions of which provider,
 * model, credentials, and reasoning level an agent should run on. Constructors return data only - the
 * Session composition root lowers a descriptor to a LanguageModel context when it builds or switches a
 * runtime, so no client or provider layer wiring appears in caller code (D15's provisioning seam).
 */
import { Data, Redacted } from 'effect'
import type { Effect, Scope } from 'effect'
import type { LanguageModel } from 'effect/ai'
import type { HttpClient } from 'effect/http'

import type { ActiveModel, OpenAiReasoningSummary, ReasoningLevel } from '../EventLog/Schemas'
import { resolveAnthropicThinking, resolveOpenAiReasoning } from '../Model/ModelRequestSettings'
import { anthropicLanguageModel, openAiCompatibleLanguageModel } from './ProviderModels'

/**
 * Which provider a model talks to, as data: a known provider connection (credentials and base URL), or
 * a custom implementation - the extension seam for scripted test models and provider packages. How the
 * LanguageModel is built lives on the model's `make`.
 */
export type FoldModelProvider = Data.TaggedEnum<{
	'openai-compatible': {
		readonly apiKey: Redacted.Redacted<string>
		readonly apiKeyHeader?: string | null
		readonly baseUrl: string | null
	}
	anthropic: {
		readonly apiKey: Redacted.Redacted<string>
		readonly baseUrl: string | null
	}
	custom: {}
}>

const FoldModelProvider = Data.taggedEnum<FoldModelProvider>()

/**
 * One model an agent can run on: the resolved ActiveModel snapshot recorded in the durable log plus the
 * provider connection used to reach it. Built with {@link openaiModel}, {@link anthropicModel}, or
 * {@link customModel}; consumed by `Session.open` and `FoldSession.switchModel`.
 */
export type FoldModel<R = never> = {
	readonly activeModel: ActiveModel
	readonly provider: FoldModelProvider
	/**
	 * Builds the model's LanguageModel service in the runtime's scope. `R` is the host services it needs
	 * (an HttpClient for the built-in providers); `Session.open` requires them from its caller.
	 */
	readonly make: Effect.Effect<LanguageModel.LanguageModel, never, Scope.Scope | R>
}

const redact = (apiKey: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
	Redacted.isRedacted(apiKey) ? apiKey : Redacted.make(apiKey)

/** The anthropic model used when {@link AnthropicModelOptions.model} is omitted. */
export const DEFAULT_ANTHROPIC_MODEL_ID = 'claude-opus-4-8'

/** Connection/request options shared by {@link openaiModel} and {@link anthropicModel}. */
type ProviderModelOptionsBase = {
	readonly apiKey: string | Redacted.Redacted<string>
	/** Override the provider base URL, for example to reach an API-compatible proxy. */
	readonly baseUrl?: string
	/** Reasoning level for requests. Defaults to `off`, which leaves the provider default untouched. */
	readonly reasoning?: ReasoningLevel
	/** Configured provider profile name recorded in the log. Defaults to the provider kind. */
	readonly providerId?: string
}

/** Options for {@link openaiModel}: openai-compatible endpoints require an explicit model id. */
export type ProviderModelOptions = ProviderModelOptionsBase & {
	/** Provider model id, for example `gpt-5.6-luna`. */
	readonly model: string
	/** Replace bearer authentication with a raw API key in this header. */
	readonly apiKeyHeader?: string
	/** Request a reasoning summary. Omitted by default for provider compatibility. */
	readonly reasoningSummary?: OpenAiReasoningSummary
}

/** Options for {@link anthropicModel}: the model id defaults to {@link DEFAULT_ANTHROPIC_MODEL_ID}. */
export type AnthropicModelOptions = ProviderModelOptionsBase & {
	/** Provider model id, for example `claude-opus-4-8`. Defaults to {@link DEFAULT_ANTHROPIC_MODEL_ID}. */
	readonly model?: string
}

/** Describe a model served by any OpenAI-compatible endpoint. */
export const openaiModel = (options: ProviderModelOptions): FoldModel<HttpClient.HttpClient> => {
	const level = options.reasoning ?? 'off'
	const apiKey = redact(options.apiKey)
	const apiKeyHeader = options.apiKeyHeader ?? null
	const baseUrl = options.baseUrl ?? null

	return {
		activeModel: {
			providerId: options.providerId ?? 'openai',
			providerKind: 'openai-compatible',
			modelId: options.model,
			role: null,
			requestedReasoningLevel: level,
			reasoning: resolveOpenAiReasoning(level),
			reasoningSummary: options.reasoningSummary,
		},
		provider: FoldModelProvider['openai-compatible']({ apiKey, apiKeyHeader, baseUrl }),
		make: openAiCompatibleLanguageModel({ modelId: options.model, apiKey, apiKeyHeader, baseUrl }),
	}
}

/** Describe a model served by any Anthropic-compatible endpoint. */
export const anthropicModel = (options: AnthropicModelOptions): FoldModel<HttpClient.HttpClient> => {
	const level = options.reasoning ?? 'off'
	const model = options.model ?? DEFAULT_ANTHROPIC_MODEL_ID
	const apiKey = redact(options.apiKey)
	const baseUrl = options.baseUrl ?? null

	return {
		activeModel: {
			providerId: options.providerId ?? 'anthropic',
			providerKind: 'anthropic',
			modelId: model,
			role: null,
			requestedReasoningLevel: level,
			thinking: resolveAnthropicThinking(level, model),
		},
		provider: FoldModelProvider.anthropic({ apiKey, baseUrl }),
		make: anthropicLanguageModel({ modelId: model, apiKey, baseUrl }),
	}
}

/** Options for {@link customModel}. */
export type CustomModelOptions<R = never> = {
	/** The resolved model snapshot recorded in the durable log. */
	readonly activeModel: ActiveModel
	/**
	 * Builds the LanguageModel service implementation - the escape hatch for tests and custom providers.
	 * Anything it needs from the host besides `Scope` becomes the model's `R`.
	 */
	readonly make: Effect.Effect<LanguageModel.LanguageModel, never, Scope.Scope | R>
}

/**
 * Describe a model backed by a caller-supplied LanguageModel implementation. The model needs whatever
 * `make` needs besides the `Scope` every runtime already supplies.
 */
export const customModel = <R = never>(options: CustomModelOptions<R>): FoldModel<Exclude<R, Scope.Scope>> => ({
	activeModel: options.activeModel,
	provider: FoldModelProvider.custom(),
	// SAFETY: `Scope | R` and `Scope | Exclude<R, Scope>` are the same set of services; TypeScript cannot
	// see that for a generic R.
	// oxlint-disable-next-line typescript/consistent-type-assertions, automation/no-type-assertion, effecttsgo/unsafe-effect-type-assertion
	make: options.make as Effect.Effect<LanguageModel.LanguageModel, never, Scope.Scope | Exclude<R, Scope.Scope>>,
})
