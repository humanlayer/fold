/**
 * Minimal real-model example against the OpenAI API using the high-level API: describe the agent
 * (model, prompt, an inline tool), start a session, send one turn. All service wiring - event log,
 * toolset, hooks, system prompt, request settings, runtime layers - stays inside `startSession`.
 *
 * Run: OPENAI_API_KEY=... bun packages/tart-core/examples/OpenaiAgent.ts
 */
import { Console, Effect, Schema } from 'effect'

import { defineAgent, defineTool, openaiModel, startSession } from '../src/index'

const modelId = process.env.OPENAI_MODEL ?? 'gpt-5.5'
const apiKey = Bun.env.OPENAI_API_KEY

const echo = defineTool({
	name: 'echo',
	description: 'Echoes text back to the model.',
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.Struct({ echoed: Schema.String }),
	handler: ({ text }) => Effect.succeed({ echoed: text }),
})

const makeProgram = (apiKey: string) =>
	Effect.gen(function* () {
		const session = yield* startSession({
			agent: defineAgent({
				name: 'openai-demo',
				model: openaiModel({ model: modelId, apiKey, reasoning: 'medium' }),
				systemPrompt:
					'You are a tiny Tart demo agent. When the user asks you to echo text, call the echo tool, then answer briefly.',
				tools: [echo],
			}),
		})

		const finished = yield* session.send(
			'Use the echo tool with the exact text "hello from tart", then tell me what it returned.',
		)
		const entries = yield* session.entries

		yield* Console.log(`finished: ${finished.outcome}`)
		yield* Console.log(`result: ${finished.resultText ?? '(no text)'}`)
		yield* Console.log(`log: ${entries.map((entry) => entry._tag).join(' -> ')}`)
	}).pipe(Effect.scoped)

if (apiKey === undefined || apiKey === '') {
	console.error('Set OPENAI_API_KEY to run this example.')
	process.exitCode = 1
} else {
	Effect.runPromise(makeProgram(apiKey)).catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
