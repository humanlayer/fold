/** FoldModel factory for xAI's OpenAI-compatible inference API authenticated with OAuth. */
import { OpenAiClient, OpenAiLanguageModel } from '@humanlayer/effect-ai-openai-compat'
import type {
	ChatCompletionChunk,
	CreateResponse200,
	CreateResponse200Sse,
} from '@humanlayer/effect-ai-openai-compat/OpenAiClient'
import { customModel, resolveOpenAiReasoning } from '@humanlayer/fold-core'
import type { FoldModel, ReasoningLevel } from '@humanlayer/fold-core'
import { Context, Effect, Layer, Match, Option, Predicate, Schema, Stream } from 'effect'
import type { FileSystem, Scope } from 'effect'
import { LanguageModel } from 'effect/ai'
import { HttpClient } from 'effect/http'

import { layerXaiAuthStore, type XaiAuthStoreOptions } from './AuthStore'
import { layerXaiAuth, xaiAuthenticatedClient } from './XaiAuth'
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
		onSome: ({ reasoning_tokens: reasoningTokens }) => ({
			...usage,
			completion_tokens: usage.completion_tokens + reasoningTokens,
		}),
	})
}

const normalizeXaiResponse = <Response extends CreateResponse200 | ChatCompletionChunk>(
	response: Response,
): Response => {
	if (Predicate.isNullish(response.usage)) return response
	return { ...response, usage: normalizeXaiChatCompletionUsage(response.usage) }
}

const normalizeXaiStreamResponse = (response: CreateResponse200Sse): CreateResponse200Sse =>
	Match.value(response).pipe(
		Match.when({ usage: Match.defined }, (chunk) => normalizeXaiResponse(chunk)),
		Match.orElse((event) => event),
	)

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
	/** The auth document holding this provider's credential, under the `providerId` entry. Defaults to `~/.fold/auth.json`. */
	readonly authStorePath?: string
}

/** The credential store for this model: its provider's entry in its auth document. */
const authStoreOptionsFor = (options: XaiModelOptions): XaiAuthStoreOptions =>
	options.authStorePath === undefined
		? { providerId: options.providerId ?? 'xai' }
		: { providerId: options.providerId ?? 'xai', path: options.authStorePath }

/** This model's XaiAuth over its provider's credential store, on the host's HttpClient and FileSystem. */
const authLayerFor = (options: XaiModelOptions) =>
	layerXaiAuth().pipe(Layer.provide(layerXaiAuthStore(authStoreOptionsFor(options))))

/** Build xAI's stock OpenAI-compatible LanguageModel over the OAuth transport. */
export const makeXaiLanguageModel = (
	options: XaiModelOptions,
): Effect.Effect<LanguageModel.LanguageModel, never, Scope.Scope | HttpClient.HttpClient | FileSystem.FileSystem> =>
	Layer.build(
		Layer.effect(
			LanguageModel.LanguageModel,
			Effect.gen(function* () {
				const authenticated = yield* xaiAuthenticatedClient(yield* HttpClient.HttpClient)
				const clientContext = yield* Layer.build(
					OpenAiClient.layer({ apiUrl: options.apiUrl ?? XAI_API_URL }),
				).pipe(Effect.provideService(HttpClient.HttpClient, authenticated))
				const client = decorateXaiClient(Context.get(clientContext, OpenAiClient.OpenAiClient))
				return yield* OpenAiLanguageModel.make({ model: options.model ?? DEFAULT_XAI_MODEL_ID }).pipe(
					Effect.provideService(OpenAiClient.OpenAiClient, client),
				)
			}),
		).pipe(Layer.provide(authLayerFor(options))),
	).pipe(Effect.map((context) => Context.get(context, LanguageModel.LanguageModel)))

/** Describe an xAI OAuth-backed model compatible with Fold sessions and switching. */
export const xaiModel = (options: XaiModelOptions = {}): FoldModel<HttpClient.HttpClient | FileSystem.FileSystem> => {
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
