/** Regression coverage for patched @effect/ai-anthropic client tool-result encoding. */
import { AnthropicClient, AnthropicLanguageModel } from '@effect/ai-anthropic'
import { assert, it } from '@effect/vitest'
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

it.effect('passes strings through and emits multipart client tool results in Effect 4.0.0-rc.112', () =>
	Effect.gen(function* () {
		let requestBody: unknown = null
		const preprocess: HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never> = Effect.succeed
		const httpClient = HttpClient.makeWith(
			Effect.fnUntraced(function* (requestEffect) {
				const request = yield* requestEffect
				if (!Predicate.isTagged(request.body, 'Uint8Array')) return yield* Effect.die('expected request bytes')
				requestBody = JSON.parse(new TextDecoder().decode(request.body.body))
				return HttpClientResponse.fromWeb(
					request,
					new Response(
						JSON.stringify({
							id: 'msg_repro',
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
		const stringResult = 'PLAIN_TEXT_SENTINEL\n'
		const multipartResult = [
			Prompt.textPart({ text: 'IMAGE_TEXT_SENTINEL' }),
			Prompt.filePart({ mediaType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) }),
		]

		yield* LanguageModel.generateText({
			prompt: Prompt.fromMessages([
				Prompt.assistantMessage({
					content: [
						Prompt.toolCallPart({
							id: 'call_text',
							name: 'text_tool',
							params: {},
							providerExecuted: false,
						}),
						Prompt.toolCallPart({
							id: 'call_image',
							name: 'image_tool',
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
							result: stringResult,
							isFailure: false,
							providerExecuted: false,
						}),
						Prompt.toolResultPart({
							id: 'call_image',
							name: 'image_tool',
							result: multipartResult,
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
			]),
		}).pipe(Effect.provide(modelLayer))

		const body = Schema.decodeUnknownSync(CapturedRequest)(requestBody)
		const toolResults = body.messages.flatMap((message) =>
			message.content.filter(
				(block) => block['type'] === 'tool_result' && Predicate.isString(block['tool_use_id']),
			),
		)
		const textOutput = toolResults.find((block) => block['tool_use_id'] === 'call_text')
		const imageOutput = toolResults.find((block) => block['tool_use_id'] === 'call_image')
		const objectOutput = toolResults.find((block) => block['tool_use_id'] === 'call_object')

		assert.isDefined(textOutput)
		assert.isDefined(imageOutput)
		assert.isDefined(objectOutput)
		assert.strictEqual(textOutput['content'], stringResult)
		assert.strictEqual(objectOutput['content'], JSON.stringify({ answer: 42 }))
		assert.deepStrictEqual(imageOutput['content'], [
			{ type: 'text', text: 'IMAGE_TEXT_SENTINEL' },
			{
				type: 'image',
				source: {
					type: 'base64',
					media_type: 'image/png',
					data: 'iVBORw==',
				},
			},
		])
	}),
)
