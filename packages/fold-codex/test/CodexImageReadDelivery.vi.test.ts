/**
 * Deterministic end-to-end regression for the image-read path up to the Codex HTTP boundary. It executes
 * the real read tool and session prompt builder, then asserts the intended request emitted with no active tools.
 */
import { expect, it } from '@effect/vitest'
import { Effect, Encoding, Option, Schema } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { CodexTokenData, makeCodexLanguageModel } from '../src/index'
import type { CodexAuthStore } from '../src/index'
import { type CapturedFetchRequest, makeCapturingFetch, runImageReadInference } from './SessionModelPathTestHarness'

const terminalSse = `data: ${JSON.stringify({
	type: 'response.completed',
	response: { id: 'resp_capture', model: 'gpt-5.5', created_at: 1, output: [] },
	sequence_number: 1,
})}\n\n`

const token = new CodexTokenData({
	type: 'oauth',
	access: 'capture-access-token',
	refresh: 'unused-refresh-token',
	expires: Number.MAX_SAFE_INTEGER,
	accountId: 'acct_capture',
})

const memoryAuthStore: CodexAuthStore = {
	path: 'memory://codex-image-read-capture',
	load: Effect.succeed(Option.some(token)),
	save: (updated) => Effect.succeed(updated),
	clear: Effect.void,
}

const CapturedResponsesRequest = Schema.Struct({
	model: Schema.String,
	stream: Schema.Boolean,
	input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	tools: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})

const decodeCapturedResponsesRequest = Schema.decodeUnknownSync(CapturedResponsesRequest)
const decodeWireContent = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))

it.effect('sends an actual image read as input_image with zero inference tools', () => {
	const requests: Array<CapturedFetchRequest> = []
	const capturingFetch = makeCapturingFetch(
		requests,
		() => new Response(terminalSse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
	)

	return Effect.gen(function* () {
		const model = yield* makeCodexLanguageModel({
			model: 'gpt-5.5',
			reasoning: 'off',
			apiUrl: 'https://codex.capture.test/backend-api/codex',
			store: memoryAuthStore,
			requestRetryTimes: 0,
		})
		const fixture = yield* runImageReadInference(model)

		expect(requests).toHaveLength(1)
		const captured = requests[0]
		if (captured === undefined) throw new Error('expected one captured Responses request')
		expect(captured.url).toBe('https://codex.capture.test/backend-api/codex/responses')
		expect(captured.authorization).toBe('Bearer capture-access-token')
		if (process.env.FOLD_CODEX_DUMP_IMAGE_READ_REQUEST === '1') {
			yield* Effect.sync(() => process.stdout.write(`${captured.body}\n`))
		}

		const body = decodeCapturedResponsesRequest(JSON.parse(captured.body))
		expect(body.model).toBe('gpt-5.5')
		expect(body.stream).toBe(true)
		// AgentRuntime passes an empty active toolkit; the provider omits `tools` entirely on the wire.
		expect(body.tools).toBeUndefined()

		// The production read tool returned the exact generated PNG, and RequestBuilder lowered it to
		// native Prompt parts inside the original tool result.
		expect(JSON.stringify(fixture.readResult)).toContain(fixture.sourceImageBase64)
		const promptFileParts = fixture.prompt.content.flatMap((message) => {
			if (message.role !== 'tool') return []
			return message.content.flatMap((part) =>
				part.type === 'tool-result' && Array.isArray(part.result)
					? part.result.filter((resultPart) => resultPart.type === 'file')
					: [],
			)
		})
		expect(promptFileParts).toHaveLength(1)
		const promptImage = promptFileParts[0]
		if (!(promptImage?.data instanceof Uint8Array)) throw new Error('expected decoded image bytes')
		expect(Encoding.encodeBase64(promptImage.data)).toBe(fixture.sourceImageBase64)

		// Text and image stay correlated in the native multipart function output.
		const functionOutput = body.input.find((item) => item['type'] === 'function_call_output')
		if (functionOutput === undefined || !Array.isArray(functionOutput['output']))
			throw new Error('expected multipart function_call_output')
		const functionContent = decodeWireContent(functionOutput['output'])
		const imageParts = functionContent.filter((part) => part['type'] === 'input_image')
		expect(imageParts).toHaveLength(1)
		expect(imageParts[0]?.['image_url']).toBe(`data:image/png;base64,${fixture.sourceImageBase64}`)
		expect(functionContent.filter((part) => part['type'] === 'input_text')).toHaveLength(1)
		expect(captured.body).not.toContain('Image omitted here')
		expect(captured.body).not.toContain('The following image content belongs')
		expect(captured.body).toContain(fixture.sourceImageBase64)
	}).pipe(Effect.provideService(FetchHttpClient.Fetch, capturingFetch))
})
