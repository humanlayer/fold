/**
 * RED integration coverage for model-facing built-in tool results. The fixture executes production
 * handlers against real files/processes, persists their untouched values, projects the session prompt,
 * and captures the JSON emitted by the stock OpenAI Responses provider.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { OpenAiClient, OpenAiLanguageModel } from '@effect/ai-openai'
import { assert, it } from '@effect/vitest'
import { bashTool, editTool, readTool, writeTool } from '@humanlayer/fold-agent'
import { Effect, Layer, Redacted, Schema } from 'effect'
import { LanguageModel } from 'effect/unstable/ai'
import { FetchHttpClient } from 'effect/unstable/http'

import {
	buildSessionPromptWithToolResults,
	type CapturedFetchRequest,
	decodeToolResultJson,
	executeToolHandler,
	makeCapturingFetch,
	makeTemporaryTestDirectory,
} from './SessionModelPathTestHarness'

const openAiResponse = {
	id: 'resp_tool_result_formatting',
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

const CapturedResponsesRequest = Schema.Struct({
	input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
})

const decodeCapturedResponsesRequest = Schema.decodeUnknownSync(CapturedResponsesRequest)

const outputStringsFrom = (body: string): ReadonlyArray<string> => {
	const request = decodeCapturedResponsesRequest(JSON.parse(body))
	return request.input.flatMap((item) =>
		item['type'] === 'function_call_output' && typeof item['output'] === 'string' ? [item['output']] : [],
	)
}

const expectedModelText = [
	'read alpha\nread beta\n',
	'bash success\n',
	'bash failure\n\n\nCommand exited with code 7',
	'Successfully wrote 16 bytes to nested/written.txt',
	'Successfully replaced 1 block(s) in editable.txt.',
]

const expectedDurableResults: ReadonlyArray<typeof Schema.Json.Type> = [
	{ _tag: 'text', text: 'read alpha\nread beta\n' },
	{ _tag: 'text', text: 'bash success\n' },
	{ _tag: 'failure', text: 'bash failure\n\n\nCommand exited with code 7' },
	{ _tag: 'text', text: 'Successfully wrote 16 bytes to nested/written.txt' },
	{ _tag: 'text', text: 'Successfully replaced 1 block(s) in editable.txt.' },
]

const makeActualBuiltInToolResults = Effect.gen(function* () {
	const directory = yield* makeTemporaryTestDirectory('fold-tool-result-formatting-')
	writeFileSync(join(directory, 'read-source.txt'), 'read alpha\nread beta\n')
	writeFileSync(join(directory, 'editable.txt'), 'before edit\nkeep\n')

	const readResult = yield* executeToolHandler(readTool({ cwd: directory }), { path: 'read-source.txt' })
	const bashSuccessResult = yield* executeToolHandler(bashTool({ cwd: directory, spillDir: directory }), {
		command: "printf 'bash success\\n'",
	})
	const bashFailureResult = yield* executeToolHandler(bashTool({ cwd: directory, spillDir: directory }), {
		command: "printf 'bash failure\\n'; exit 7",
	}).pipe(Effect.flip)
	const writeResult = yield* executeToolHandler(writeTool({ cwd: directory }), {
		path: 'nested/written.txt',
		content: 'written by tool\n',
	})
	const editResult = yield* executeToolHandler(editTool({ cwd: directory }), {
		path: 'editable.txt',
		edits: [{ oldText: 'before edit', newText: 'after edit' }],
	})

	const rawResults = yield* Effect.all([
		decodeToolResultJson(readResult),
		decodeToolResultJson(bashSuccessResult),
		decodeToolResultJson(bashFailureResult),
		decodeToolResultJson(writeResult),
		decodeToolResultJson(editResult),
	])
	const names = ['read', 'bash', 'bash', 'write', 'edit']
	const params = [
		{ path: 'read-source.txt' },
		{ command: "printf 'bash success\\n'" },
		{ command: "printf 'bash failure\\n'; exit 7" },
		{ path: 'nested/written.txt', content: 'written by tool\n' },
		{ path: 'editable.txt', edits: [{ oldText: 'before edit', newText: 'after edit' }] },
	]
	const { prompt, entries } = yield* buildSessionPromptWithToolResults({
		userText: 'Run the requested built-in operations.',
		toolResults: rawResults.map((result, index) => ({
			name: names[index] ?? 'unexpected',
			params: params[index] ?? {},
			result,
			isFailure: index === 2,
		})),
	})
	return { directory, rawResults, prompt, entries }
})

it.live('keeps actual built-in handler values structured in the durable EventLog', () =>
	Effect.gen(function* () {
		const { directory, entries, rawResults } = yield* makeActualBuiltInToolResults

		assert.deepStrictEqual([...rawResults], expectedDurableResults)
		assert.deepStrictEqual(
			entries.map((entry) => {
				const part = entry.message.content[0]
				if (part?.type !== 'tool-result') throw new Error('expected a durable tool-result part')
				return part.result
			}),
			rawResults,
		)
		assert.strictEqual(readFileSync(join(directory, 'nested/written.txt'), 'utf8'), 'written by tool\n')
		assert.strictEqual(readFileSync(join(directory, 'editable.txt'), 'utf8'), 'after edit\nkeep\n')
	}),
)

it.live('RED: sends actual built-in tool results as plain Responses function outputs', () =>
	Effect.gen(function* () {
		const { prompt } = yield* makeActualBuiltInToolResults

		const requests: Array<CapturedFetchRequest> = []
		const capturingFetch = makeCapturingFetch(
			requests,
			() =>
				new Response(JSON.stringify(openAiResponse), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		)
		const httpLayer = FetchHttpClient.layer.pipe(
			Layer.provide(Layer.succeed(FetchHttpClient.Fetch, capturingFetch)),
		)
		const clientLayer = OpenAiClient.layer({ apiKey: Redacted.make('sk-test') }).pipe(Layer.provide(httpLayer))
		const modelLayer = OpenAiLanguageModel.model('gpt-test').pipe(Layer.provide(clientLayer))

		yield* LanguageModel.generateText({ prompt }).pipe(Effect.provide(modelLayer))

		assert.strictEqual(requests.length, 1)
		const captured = requests[0]
		if (captured === undefined) throw new Error('expected one captured OpenAI Responses request')
		assert.strictEqual(captured.url, 'https://api.openai.com/v1/responses')

		// Intended model contract: expose each handler's inner text/output/message, never its JSON envelope.
		assert.deepStrictEqual(outputStringsFrom(captured.body), expectedModelText)
	}),
)
