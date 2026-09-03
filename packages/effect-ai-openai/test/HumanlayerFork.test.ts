import { assert, describe, it } from '@effect/vitest'
import { OpenAiClient, OpenAiLanguageModel, OpenAiSchema } from '@humanlayer/effect-ai-openai'
import { Effect, Layer, Predicate, Redacted, Schema } from 'effect'
import { LanguageModel, Prompt } from 'effect/unstable/ai'
import { FetchHttpClient } from 'effect/unstable/http'

const OpenAiResponse = {
	id: 'resp_humanlayer_provider_test',
	object: 'response',
	created_at: 0,
	model: 'gpt-test',
	status: 'completed',
	output: [],
	metadata: null,
	temperature: null,
	top_p: null,
	tools: [],
	tool_choice: 'auto',
	error: null,
	incomplete_details: null,
	instructions: null,
	parallel_tool_calls: true,
}

const CapturedRequest = Schema.Struct({
	input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
})

const isWebRequest = (input: string | URL | Request): input is Request => Predicate.hasProperty(input, 'url')

const makeCapturingFetch = (requests: Array<string>): typeof fetch =>
	Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const request = isWebRequest(input) ? input : new Request(String(input), init)
			requests.push(await request.clone().text())
			return new Response(JSON.stringify(OpenAiResponse), { status: 200 })
		},
		{ preconnect: fetch.preconnect },
	)

describe('@humanlayer/effect-ai-openai', () => {
	it('uses HumanLayer-specific Effect service keys', () => {
		assert.strictEqual(OpenAiClient.OpenAiClient.key, '@humanlayer/effect-ai-openai/OpenAiClient')
		assert.strictEqual(OpenAiLanguageModel.Config.key, '@humanlayer/effect-ai-openai/OpenAiLanguageModel/Config')
	})

	it.live('preserves string and ordered multipart tool results while retaining JSON fallback', () =>
		Effect.gen(function* () {
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
			const requests: Array<string> = []
			const httpLayer = FetchHttpClient.layer.pipe(
				Layer.provide(Layer.succeed(FetchHttpClient.Fetch, makeCapturingFetch(requests))),
			)
			const modelLayer = OpenAiLanguageModel.model('gpt-test').pipe(
				Layer.provide(OpenAiClient.layer({ apiKey: Redacted.make('sk-test') }).pipe(Layer.provide(httpLayer))),
			)

			yield* LanguageModel.generateText({ prompt }).pipe(Effect.provide(modelLayer))

			const request = requests[0]
			assert.isDefined(request)
			const body = Schema.decodeUnknownSync(CapturedRequest)(JSON.parse(request))
			const outputs = body.input.filter((item) => item['type'] === 'function_call_output')
			const textOutput = outputs.find((item) => item['call_id'] === 'call_text')
			const multipartOutput = outputs.find((item) => item['call_id'] === 'call_multipart')
			const objectOutput = outputs.find((item) => item['call_id'] === 'call_object')

			assert.isDefined(textOutput)
			assert.isDefined(multipartOutput)
			assert.isDefined(objectOutput)
			assert.strictEqual(textOutput['output'], 'PLAIN_TEXT_SENTINEL\n')
			assert.deepStrictEqual(multipartOutput['output'], [
				{ type: 'input_text', text: 'BEFORE_IMAGE' },
				{ type: 'input_image', image_url: 'data:image/png;base64,iVBORw==', detail: 'auto' },
				{ type: 'input_text', text: 'AFTER_IMAGE' },
			])
			assert.strictEqual(objectOutput['output'], JSON.stringify({ answer: 42 }))
		}),
	)

	it('accepts incomplete flat and nested error events', () => {
		const flat = Schema.decodeUnknownSync(OpenAiSchema.ResponseStreamEvent)({
			type: 'error',
			message: 'flat provider error',
		})
		const nested = Schema.decodeUnknownSync(OpenAiSchema.ResponseStreamEvent)({
			type: 'error',
			error: { message: 'nested provider error' },
		})

		assert.deepStrictEqual(flat, { type: 'error', message: 'flat provider error' })
		assert.deepStrictEqual(nested, { type: 'error', message: 'nested provider error' })
	})
})
