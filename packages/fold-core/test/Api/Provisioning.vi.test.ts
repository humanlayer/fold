import { assert, it } from '@effect/vitest'
import { Effect, Layer, Predicate, Schema } from 'effect'
import { LanguageModel, Prompt } from 'effect/ai'
import { FetchHttpClient } from 'effect/http'

import {
	languageModelLayerFor,
	liveModelRequestSettingsLayer,
	ModelRequestSettings,
	openaiModel,
} from '../../src/index'

const OpenAiResponse = {
	id: 'resp_fold_provisioning_test',
	object: 'response',
	created_at: 0,
	model: 'openai.gpt-5.6-sol',
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

const CapturedRequestBody = Schema.Struct({
	model: Schema.String,
	reasoning: Schema.Struct({
		effort: Schema.String,
		summary: Schema.optional(Schema.String),
	}),
})

type CapturedRequest = {
	readonly url: string
	readonly authorization: string | null
	readonly apiKey: string | null
	readonly body: string
}

const isWebRequest = (input: string | URL | Request): input is Request => Predicate.hasProperty(input, 'url')

it.live('sends custom authentication and reasoning summary through the OpenAI-compatible model', () => {
	const requests: Array<CapturedRequest> = []
	const capturingFetch: typeof fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const request = isWebRequest(input) ? input : new Request(String(input), init)
			requests.push({
				url: request.url,
				authorization: request.headers.get('authorization'),
				apiKey: request.headers.get('api-key'),
				body: await request.clone().text(),
			})
			return new Response(JSON.stringify(OpenAiResponse), { status: 200 })
		},
		{ preconnect: fetch.preconnect },
	)
	const model = openaiModel({
		model: 'openai.gpt-5.6-sol',
		apiKey: 'azure-secret',
		apiKeyHeader: 'api-key',
		baseUrl: 'https://models.example.test/openai/v1',
		reasoning: 'medium',
		reasoningSummary: 'auto',
	})
	const prompt = Prompt.fromMessages([Prompt.userMessage({ content: [Prompt.textPart({ text: 'hello' })] })])

	return Effect.gen(function* () {
		const settings = yield* ModelRequestSettings
		yield* settings.wrap({ model: model.activeModel, reasoningLevel: 'medium' })(
			LanguageModel.generateText({ prompt }),
		)

		assert.strictEqual(requests.length, 1)
		const request = requests[0]
		assert.isDefined(request)
		assert.strictEqual(request.url, 'https://models.example.test/openai/v1/responses')
		assert.isNull(request.authorization)
		assert.strictEqual(request.apiKey, 'azure-secret')
		const body = yield* Schema.decodeUnknownEffect(CapturedRequestBody)(JSON.parse(request.body))
		assert.deepStrictEqual(body, {
			model: 'openai.gpt-5.6-sol',
			reasoning: { effort: 'medium', summary: 'auto' },
		})
	}).pipe(
		Effect.provide(
			Layer.merge(languageModelLayerFor(model), liveModelRequestSettingsLayer).pipe(
				Layer.provide(FetchHttpClient.layer),
			),
		),
		Effect.provideService(FetchHttpClient.Fetch, capturingFetch),
	)
})
