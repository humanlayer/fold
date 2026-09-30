import { assert, it } from '@effect/vitest'
/**
 * Regression coverage for patched Effect AI client tool-result encoding. This bypasses Fold handlers
 * and RequestBuilder so captured values isolate the @humanlayer/effect-ai-openai provider behavior.
 */
import { OpenAiClient, OpenAiLanguageModel } from '@humanlayer/effect-ai-openai'
import { Effect, Layer, Predicate, Redacted, Schema } from 'effect'
import { LanguageModel, Prompt } from 'effect/unstable/ai'
import { FetchHttpClient } from 'effect/unstable/http'

import { type CapturedFetchRequest, makeCapturingFetch } from './SessionModelPathTestHarness'

const openAiResponse = {
	id: 'resp_effect_tool_result_repro',
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

it.live('passes strings through and emits multipart client tool results in Effect 4.0.0-rc.112', () =>
	Effect.gen(function* () {
		const stringResult = 'PLAIN_TEXT_SENTINEL\n'
		const multipartResult = [
			Prompt.textPart({ text: 'IMAGE_TEXT_SENTINEL' }),
			Prompt.filePart({ mediaType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) }),
		]
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
		])

		const requests: Array<CapturedFetchRequest> = []
		const httpLayer = FetchHttpClient.layer.pipe(
			Layer.provide(
				Layer.succeed(
					FetchHttpClient.Fetch,
					makeCapturingFetch(requests, () => new Response(JSON.stringify(openAiResponse), { status: 200 })),
				),
			),
		)
		const modelLayer = OpenAiLanguageModel.model('gpt-test').pipe(
			Layer.provide(OpenAiClient.layer({ apiKey: Redacted.make('sk-test') }).pipe(Layer.provide(httpLayer))),
		)

		yield* LanguageModel.generateText({ prompt }).pipe(Effect.provide(modelLayer))

		const captured = requests[0]
		assert.isDefined(captured)
		const body = Schema.decodeUnknownSync(CapturedRequest)(JSON.parse(captured.body))
		const outputs = body.input.filter(
			(item) => item['type'] === 'function_call_output' && Predicate.isString(item['call_id']),
		)
		const textOutput = outputs.find((item) => item['call_id'] === 'call_text')
		const imageOutput = outputs.find((item) => item['call_id'] === 'call_image')
		const objectOutput = outputs.find((item) => item['call_id'] === 'call_object')

		assert.isDefined(textOutput)
		assert.isDefined(imageOutput)
		assert.isDefined(objectOutput)
		assert.strictEqual(textOutput['output'], stringResult)
		assert.strictEqual(objectOutput['output'], JSON.stringify({ answer: 42 }))
		assert.deepStrictEqual(imageOutput['output'], [
			{ type: 'input_text', text: 'IMAGE_TEXT_SENTINEL' },
			{
				type: 'input_image',
				image_url: 'data:image/png;base64,iVBORw==',
				detail: 'auto',
			},
		])
	}),
)
