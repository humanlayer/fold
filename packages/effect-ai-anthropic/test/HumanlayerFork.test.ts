import { assert, describe, it } from '@effect/vitest'
import { AnthropicClient, AnthropicLanguageModel } from '@humanlayer/effect-ai-anthropic'
import { Effect, Layer, Predicate, Redacted, Schema } from 'effect'
import { LanguageModel, Prompt } from 'effect/unstable/ai'
import { HttpClient, type HttpClientError, HttpClientResponse } from 'effect/unstable/http'

const CapturedRequest = Schema.Struct({
	messages: Schema.Array(
		Schema.Struct({
			role: Schema.String,
			content: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
		}),
	),
})

describe('@humanlayer/effect-ai-anthropic', () => {
	it('uses HumanLayer-specific Effect service keys', () => {
		assert.strictEqual(AnthropicClient.AnthropicClient.key, '@humanlayer/effect-ai-anthropic/AnthropicClient')
		assert.strictEqual(
			AnthropicLanguageModel.Config.key,
			'@humanlayer/effect-ai-anthropic/AnthropicLanguageModel/Config',
		)
	})

	it.effect('preserves string and ordered multipart tool results while retaining JSON fallback', () =>
		Effect.gen(function* () {
			let requestBody: unknown = null
			const preprocess: HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never> = Effect.succeed
			const httpClient = HttpClient.makeWith(
				Effect.fnUntraced(function* (requestEffect) {
					const request = yield* requestEffect
					if (!Predicate.isTagged(request.body, 'Uint8Array')) {
						return yield* Effect.die('Expected request bytes')
					}
					requestBody = JSON.parse(new TextDecoder().decode(request.body.body))
					return HttpClientResponse.fromWeb(
						request,
						new Response(
							JSON.stringify({
								id: 'msg_humanlayer_provider_test',
								type: 'message',
								role: 'assistant',
								model: 'claude-test',
								content: [{ type: 'text', text: 'ok' }],
								stop_reason: 'end_turn',
								stop_sequence: null,
								usage: {
									cache_creation: null,
									cache_creation_input_tokens: null,
									cache_read_input_tokens: null,
									inference_geo: null,
									input_tokens: 1,
									output_tokens: 1,
									service_tier: null,
								},
							}),
							{ status: 200, headers: { 'content-type': 'application/json' } },
						),
					)
				}),
				preprocess,
			)
			const clientLayer = AnthropicClient.layer({ apiKey: Redacted.make('sk-test') }).pipe(
				Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
			)
			const modelLayer = AnthropicLanguageModel.model('claude-test').pipe(Layer.provide(clientLayer))
			const prompt = Prompt.fromMessages([
				Prompt.assistantMessage({
					content: [
						Prompt.toolCallPart({
							id: 'call_text',
							name: 'text_tool',
							params: {},
							providerExecuted: false,
						}),
						Prompt.toolCallPart({
							id: 'call_multipart',
							name: 'multipart_tool',
							params: {},
							providerExecuted: false,
						}),
						Prompt.toolCallPart({
							id: 'call_object',
							name: 'object_tool',
							params: {},
							providerExecuted: false,
						}),
					],
				}),
				Prompt.toolMessage({
					content: [
						Prompt.toolResultPart({
							id: 'call_text',
							name: 'text_tool',
							result: 'PLAIN_TEXT_SENTINEL\n',
							isFailure: false,
							providerExecuted: false,
						}),
						Prompt.toolResultPart({
							id: 'call_multipart',
							name: 'multipart_tool',
							result: [
								Prompt.textPart({ text: 'BEFORE_IMAGE' }),
								Prompt.filePart({ mediaType: 'image/png', data: 'iVBORw==' }),
								Prompt.textPart({ text: 'AFTER_IMAGE' }),
							],
							isFailure: false,
							providerExecuted: false,
						}),
						Prompt.toolResultPart({
							id: 'call_object',
							name: 'object_tool',
							result: { answer: 42 },
							isFailure: false,
							providerExecuted: false,
						}),
					],
				}),
			])

			yield* LanguageModel.generateText({ prompt }).pipe(Effect.provide(modelLayer))

			const body = Schema.decodeUnknownSync(CapturedRequest)(requestBody)
			const toolResults = body.messages.flatMap((message) =>
				message.content.filter((block) => block['type'] === 'tool_result'),
			)
			const textOutput = toolResults.find((block) => block['tool_use_id'] === 'call_text')
			const multipartOutput = toolResults.find((block) => block['tool_use_id'] === 'call_multipart')
			const objectOutput = toolResults.find((block) => block['tool_use_id'] === 'call_object')

			assert.isDefined(textOutput)
			assert.isDefined(multipartOutput)
			assert.isDefined(objectOutput)
			assert.strictEqual(textOutput['content'], 'PLAIN_TEXT_SENTINEL\n')
			assert.deepStrictEqual(multipartOutput['content'], [
				{ type: 'text', text: 'BEFORE_IMAGE' },
				{
					type: 'image',
					source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' },
				},
				{ type: 'text', text: 'AFTER_IMAGE' },
			])
			assert.strictEqual(objectOutput['content'], JSON.stringify({ answer: 42 }))
		}),
	)
})
