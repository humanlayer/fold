/** FoldModel factory for xAI's OpenAI-compatible inference API authenticated with OAuth. */
import { OpenAiClient, OpenAiLanguageModel } from '@effect/ai-openai'
import { customModel, resolveOpenAiReasoning } from '@humanlayer/fold-core'
import type { FoldModel, ReasoningLevel } from '@humanlayer/fold-core'
import { Context, Effect, Layer } from 'effect'
import type { Scope } from 'effect'
import type { LanguageModel } from 'effect/unstable/ai'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'

import type { XaiAuthStore } from './AuthStore'
import { makeXaiAuth, withXaiAuth } from './XaiAuth'

export const XAI_API_URL = 'https://api.x.ai/v1'
export const DEFAULT_XAI_MODEL_ID = 'grok-4.5'

export type XaiModelOptions = {
	readonly model?: string
	readonly reasoning?: ReasoningLevel
	readonly providerId?: string
	readonly apiUrl?: string
	readonly store?: XaiAuthStore
}

/** Build xAI's stock OpenAI-compatible LanguageModel over the OAuth transport. */
export const makeXaiLanguageModel = (
	options: XaiModelOptions,
): Effect.Effect<LanguageModel.Service, never, Scope.Scope> =>
	Effect.gen(function* () {
		const httpContext = yield* Layer.build(FetchHttpClient.layer)
		const base = Context.get(httpContext, HttpClient.HttpClient)
		const auth = yield* makeXaiAuth(options.store === undefined ? {} : { store: options.store }).pipe(
			Effect.provideService(HttpClient.HttpClient, base),
		)
		const clientContext = yield* Layer.build(OpenAiClient.layer({ apiUrl: options.apiUrl ?? XAI_API_URL })).pipe(
			Effect.provideService(HttpClient.HttpClient, withXaiAuth(base, auth)),
		)
		return yield* OpenAiLanguageModel.make({ model: options.model ?? DEFAULT_XAI_MODEL_ID }).pipe(
			Effect.provideService(OpenAiClient.OpenAiClient, Context.get(clientContext, OpenAiClient.OpenAiClient)),
		)
	})

/** Describe an xAI OAuth-backed model compatible with Fold sessions and switching. */
export const xaiModel = (options: XaiModelOptions = {}): FoldModel => {
	const level = options.reasoning ?? 'off'
	return customModel({
		activeModel: {
			providerId: options.providerId ?? 'xai',
			providerKind: 'openai-compatible',
			modelId: options.model ?? DEFAULT_XAI_MODEL_ID,
			role: null,
			requestedReasoningLevel: level,
			reasoning: resolveOpenAiReasoning(level),
		},
		make: makeXaiLanguageModel(options),
	})
}
