/**
 * This file builds the LanguageModel service for the two built-in provider connections - any
 * OpenAI-compatible endpoint and any Anthropic-compatible endpoint - over the HttpClient the host
 * provides. `openaiModel`/`anthropicModel` store the result as their descriptor's `make`.
 */
import { AnthropicClient, AnthropicLanguageModel } from '@humanlayer/effect-ai-anthropic'
import { OpenAiClient, OpenAiLanguageModel } from '@humanlayer/effect-ai-openai'
import { Context, Effect, Layer, type Redacted, type Scope, Stream } from 'effect'
import { LanguageModel } from 'effect/unstable/ai'
import { HttpClient } from 'effect/unstable/http'

const anthropicDecoderModelFor = (modelId: string): string | null => {
	const id = modelId.toLowerCase()
	if (id.includes('opus')) return id === 'claude-opus-4-6' ? null : 'claude-opus-4-6'
	if (id.includes('sonnet')) return id === 'claude-sonnet-4-6' ? null : 'claude-sonnet-4-6'
	if (id.includes('haiku')) return id === 'claude-haiku-4-5' ? null : 'claude-haiku-4-5'
	if (id.includes('fable') || id.includes('mythos')) return 'claude-opus-4-6'
	return null
}

/**
 * The beta Anthropic SDK decodes streamed `message.model` against a generated literal union that can
 * lag behind real model ids accepted by the API. Rewrite only that metadata field in the raw SSE bytes
 * to a decoder-known sibling; the actual request still uses the configured model id.
 */
const relaxAnthropicResponseModel = (modelId: string): ((client: HttpClient.HttpClient) => HttpClient.HttpClient) => {
	const decoderModel = anthropicDecoderModelFor(modelId)
	if (decoderModel === null) return (client) => client

	const needle = `"model":"${modelId}"`
	const replacement = `"model":"${decoderModel}"`

	return (client) =>
		HttpClient.transformResponse(client, (responseEffect) =>
			Effect.map(responseEffect, (response) => {
				const stream = response.stream.pipe(
					Stream.decodeText,
					Stream.map((chunk) => chunk.replaceAll(needle, replacement)),
					Stream.encodeText,
				)

				// This preserves the HttpClientResponse instance and only overrides the streaming body getter.
				// The Anthropic generated client only needs `stream` for createMessageStream.
				return new Proxy(response, {
					get: (target, property, receiver) =>
						// oxlint-disable-next-line anti-slop/no-reflect-get -- a Proxy trap forwards every other property unchanged
						property === 'stream' ? stream : Reflect.get(target, property, receiver),
				})
			}),
		)
}

/** The session-fixed services every provisioned runtime closes over (one instance each per session). */
/** Build the LanguageModel for one layer in the caller's scope. */
const languageModelFrom = <E, R>(
	layer: Layer.Layer<LanguageModel.LanguageModel, E, R>,
): Effect.Effect<LanguageModel.Service, E, Scope.Scope | R> =>
	Layer.build(layer).pipe(Effect.map((context) => Context.get(context, LanguageModel.LanguageModel)))

/** The LanguageModel for an OpenAI-compatible endpoint, over the host's HttpClient. */
export const openAiCompatibleLanguageModel = (connection: {
	readonly modelId: string
	readonly apiKey: Redacted.Redacted<string>
	readonly apiKeyHeader: string | null
	readonly baseUrl: string | null
}): Effect.Effect<LanguageModel.Service, never, Scope.Scope | HttpClient.HttpClient> => {
	const clientOptions = {
		apiKey: connection.apiKey,
		apiKeyHeader: connection.apiKeyHeader ?? undefined,
		apiUrl: connection.baseUrl ?? undefined,
	}

	return languageModelFrom(
		OpenAiLanguageModel.layer({ model: connection.modelId }).pipe(Layer.provide(OpenAiClient.layer(clientOptions))),
	)
}

/** The LanguageModel for an Anthropic-compatible endpoint, over the host's HttpClient. */
export const anthropicLanguageModel = (connection: {
	readonly modelId: string
	readonly apiKey: Redacted.Redacted<string>
	readonly baseUrl: string | null
}): Effect.Effect<LanguageModel.Service, never, Scope.Scope | HttpClient.HttpClient> => {
	const clientOptions = {
		apiKey: connection.apiKey,
		apiUrl: connection.baseUrl ?? undefined,
		transformClient: relaxAnthropicResponseModel(connection.modelId),
	}

	return languageModelFrom(
		AnthropicLanguageModel.layer({ model: connection.modelId }).pipe(
			Layer.provide(AnthropicClient.layer(clientOptions)),
		),
	)
}
