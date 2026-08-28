/** FoldModel factory for xAI's OpenAI-compatible inference API authenticated with OAuth. */
import { OpenAiClient, OpenAiLanguageModel } from '@effect/ai-openai-compat'
import type {
	ChatCompletionChunk,
	CreateResponse200,
	CreateResponse200Sse,
} from '@effect/ai-openai-compat/OpenAiClient'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { customModel, resolveOpenAiReasoning } from '@humanlayer/fold-core'
import type { FoldModel, ReasoningLevel } from '@humanlayer/fold-core'
import { Context, Effect, Layer, Option, Predicate, Schema, Stream } from 'effect'
import type { Scope } from 'effect'
import type { LanguageModel } from 'effect/unstable/ai'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'

import type { XaiAuthStore } from './AuthStore'
import { makeXaiAuth, withXaiAuth } from './XaiAuth'
import { DEFAULT_XAI_MODEL_ID } from './XaiModelCatalog'

export const XAI_API_URL = 'https://api.x.ai/v1'

const TokenCount = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const XaiCompletionTokenDetails = Schema.Struct({ reasoning_tokens: TokenCount })
const decodeXaiCompletionTokenDetails = Schema.decodeUnknownOption(XaiCompletionTokenDetails)

type XaiUsage = NonNullable<CreateResponse200['usage']>

/**
 * xAI reports `completion_tokens` as text-only while putting reasoning tokens in
 * `completion_tokens_details`. OpenAI-compatible clients expect `completion_tokens` to include both.
 */
export const normalizeXaiChatCompletionUsage = (usage: XaiUsage): XaiUsage => {
	const details = decodeXaiCompletionTokenDetails(usage.completion_tokens_details)
	return Option.match(details, {
		onNone: () => usage,
		onSome: ({ reasoning_tokens: reasoningTokens }) => {
			const inclusiveOutputTokens = usage.completion_tokens + reasoningTokens
			return usage.total_tokens === usage.prompt_tokens + inclusiveOutputTokens
				? { ...usage, completion_tokens: inclusiveOutputTokens }
				: usage
		},
	})
}

const normalizeXaiResponse = <Response extends CreateResponse200 | ChatCompletionChunk>(
	response: Response,
): Response => {
	if (Predicate.isNullish(response.usage)) return response
	return { ...response, usage: normalizeXaiChatCompletionUsage(response.usage) }
}

const normalizeXaiStreamResponse = (response: CreateResponse200Sse): CreateResponse200Sse =>
	typeof response === 'string' || '_tag' in response ? response : normalizeXaiResponse(response)

/** Normalize xAI's token semantics before the stock OpenAI-compatible model derives usage details. */
export const decorateXaiClient = (inner: OpenAiClient.Service): OpenAiClient.Service => ({
	...inner,
	createResponse: (options) =>
		inner.createResponse(options).pipe(Effect.map(([body, response]) => [normalizeXaiResponse(body), response])),
	createResponseStream: (options) =>
		inner
			.createResponseStream(options)
			.pipe(Effect.map(([response, stream]) => [response, stream.pipe(Stream.map(normalizeXaiStreamResponse))])),
})

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
		const client = decorateXaiClient(Context.get(clientContext, OpenAiClient.OpenAiClient))
		return yield* OpenAiLanguageModel.make({ model: options.model ?? DEFAULT_XAI_MODEL_ID }).pipe(
			Effect.provideService(OpenAiClient.OpenAiClient, client),
		)
	}).pipe(Effect.provide(NodeFileSystem.layer))

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
