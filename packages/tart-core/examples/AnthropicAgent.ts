/**
 * Minimal real-model example against the Anthropic API using the high-level API. The agent starts on a
 * claude-family model, so the toolset resolver advertises write/edit-style tools (apply_patch would be
 * hidden if installed) and request settings apply adaptive thinking with per-request effort on current
 * claude models (pre-adaptive models like Haiku 4.5 get a thinking budget instead).
 *
 * Run: ANTHROPIC_API_KEY=... bun packages/tart-core/examples/AnthropicAgent.ts
 */
import { Console, Effect, Schema } from 'effect'

import { anthropicModel, defineAgent, defineTool, startSession } from '../src/index'

const modelId = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'
const apiKey = process.env.ANTHROPIC_API_KEY

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
				name: 'anthropic-demo',
				model: anthropicModel({ model: modelId, apiKey, reasoning: 'medium' }),
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
	console.error('Set ANTHROPIC_API_KEY to run this example.')
	process.exitCode = 1
} else {
	Effect.runPromise(makeProgram(apiKey)).catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
