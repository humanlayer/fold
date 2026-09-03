import { AnthropicClient, AnthropicLanguageModel } from '@humanlayer/effect-ai-anthropic'
import { OpenAiClient, OpenAiLanguageModel } from '@humanlayer/effect-ai-openai'
import { Effect, Layer, Predicate, Redacted } from 'effect'
import { LanguageModel, Prompt } from 'effect/unstable/ai'
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/unstable/http'

const fail = (message) => {
	throw new Error(message)
}

const assertEqual = (actual, expected, description) => {
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		fail(`${description}\nexpected: ${JSON.stringify(expected)}\nreceived: ${JSON.stringify(actual)}`)
}

const prompt = Prompt.fromMessages([
	Prompt.assistantMessage({
		content: [
			Prompt.toolCallPart({ id: 'call_text', name: 'text_tool', params: {}, providerExecuted: false }),
			Prompt.toolCallPart({ id: 'call_image', name: 'image_tool', params: {}, providerExecuted: false }),
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
				id: 'call_image',
				name: 'image_tool',
				result: [
					Prompt.textPart({ text: 'IMAGE_TEXT_SENTINEL' }),
					Prompt.filePart({ mediaType: 'image/png', data: 'iVBORw==' }),
				],
				isFailure: false,
				providerExecuted: false,
			}),
		],
	}),
])

const openAiResponse = {
	id: 'resp_external_consumer_test',
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

const anthropicResponse = {
	id: 'msg_external_consumer_test',
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
}

const runOpenAiEncodingCheck = async () => {
	const requests = []
	const fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(String(input), init)
		requests.push(JSON.parse(await request.clone().text()))
		return new Response(JSON.stringify(openAiResponse), { status: 200 })
	}
	const httpLayer = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
	const modelLayer = OpenAiLanguageModel.model('gpt-test').pipe(
		Layer.provide(OpenAiClient.layer({ apiKey: Redacted.make('sk-test') }).pipe(Layer.provide(httpLayer))),
	)

	await Effect.runPromise(LanguageModel.generateText({ prompt }).pipe(Effect.provide(modelLayer)))

	const outputs = requests[0]?.input.filter((item) => item.type === 'function_call_output')
	const outputFor = (callId) => outputs?.find((item) => item.call_id === callId)?.output
	assertEqual(outputFor('call_text'), 'PLAIN_TEXT_SENTINEL\n', 'OpenAI string tool result')
	assertEqual(
		outputFor('call_image'),
		[
			{ type: 'input_text', text: 'IMAGE_TEXT_SENTINEL' },
			{ type: 'input_image', image_url: 'data:image/png;base64,iVBORw==', detail: 'auto' },
		],
		'OpenAI multipart tool result',
	)
}

const runAnthropicEncodingCheck = async () => {
	let requestBody
	const httpClient = HttpClient.makeWith(
		Effect.fnUntraced(function* (requestEffect) {
			const request = yield* requestEffect
			if (!Predicate.isTagged(request.body, 'Uint8Array')) return yield* Effect.die('Expected request bytes')
			requestBody = JSON.parse(new TextDecoder().decode(request.body.body))
			return HttpClientResponse.fromWeb(
				request,
				new Response(JSON.stringify(anthropicResponse), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
		}),
		Effect.succeed,
	)
	const clientLayer = AnthropicClient.layer({ apiKey: Redacted.make('sk-test') }).pipe(
		Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
	)
	const modelLayer = AnthropicLanguageModel.model('claude-test').pipe(Layer.provide(clientLayer))

	await Effect.runPromise(LanguageModel.generateText({ prompt }).pipe(Effect.provide(modelLayer)))

	const results = requestBody.messages.flatMap((message) =>
		message.content.filter((block) => block.type === 'tool_result'),
	)
	const outputFor = (callId) => results.find((item) => item.tool_use_id === callId)?.content
	assertEqual(outputFor('call_text'), 'PLAIN_TEXT_SENTINEL\n', 'Anthropic string tool result')
	assertEqual(
		outputFor('call_image'),
		[
			{ type: 'text', text: 'IMAGE_TEXT_SENTINEL' },
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } },
		],
		'Anthropic multipart tool result',
	)
}

await import('@humanlayer/effect-ai-openai-compat/OpenAiClient')
await import('@humanlayer/fold-core')
await runOpenAiEncodingCheck()
await runAnthropicEncodingCheck()
