/**
 * Mid-session model switch example on the high-level API: turn 1 runs on OpenAI (gpt family), then
 * `session.switchModel` moves the same session to Anthropic (claude family) and turn 2 continues the
 * same durable log.
 *
 * The switch durably records the D17 epoch transition - `model-change`, a recomposed leading
 * `system-message` for the new family (latest leading wins; the family base prompts below make the
 * recomposition visible), and `tools-change` with the newly resolved toolset - and provisions the new
 * provider for every subsequent send. The printed log tags show all three entries between the turns.
 *
 * Run: OPENAI_API_KEY=... ANTHROPIC_API_KEY=... bun packages/tart-core/examples/ModelSwitch.ts
 */
import { Console, Effect, Schema } from 'effect'

import { anthropicModel, defineAgent, defineTool, openaiModel, startSession } from '../src/index'

const openAiModelId = process.env.OPENAI_MODEL ?? 'gpt-5.5'
const anthropicModelId = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'
const openAiKey = Bun.env.OPENAI_API_KEY
const anthropicKey = Bun.env.ANTHROPIC_API_KEY

const echo = defineTool({
	name: 'echo',
	description: 'Echoes text back to the model.',
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.Struct({ echoed: Schema.String }),
	handler: ({ text }) => Effect.succeed({ echoed: text }),
})

const makeProgram = (openAiKey: string, anthropicKey: string) =>
	Effect.gen(function* () {
		const session = yield* startSession({
			agent: defineAgent({
				name: 'model-switch-demo',
				model: openaiModel({ model: openAiModelId, apiKey: openAiKey, reasoning: 'medium' }),
				// The agent's own prompt blocks stay constant across epochs; the family base prompt
				// swaps around them when the model family changes.
				systemPrompt:
					'You are a tiny Tart demo agent. When the user asks you to echo text, call the echo tool, then answer briefly.',
				basePrompts: {
					gpt: 'GPT family base prompt: keep answers terse.',
					claude: 'Claude family base prompt: explain what you did in one sentence.',
				},
				tools: [echo],
			}),
		})

		const first = yield* session.send('Use the echo tool with the exact text "hello from openai".')
		yield* Console.log(`turn 1 (${openAiModelId}): ${first.resultText ?? '(no text)'}`)

		yield* session.switchModel(
			anthropicModel({ model: anthropicModelId, apiKey: anthropicKey, reasoning: 'medium' }),
			{
				reason: 'user switched providers',
			},
		)

		const second = yield* session.send('Echo "hello from anthropic", and tell me what your base instructions say.')
		yield* Console.log(`turn 2 (${anthropicModelId}): ${second.resultText ?? '(no text)'}`)

		const entries = yield* session.entries
		yield* Console.log(`log: ${entries.map((entry) => entry._tag).join(' -> ')}`)
	}).pipe(Effect.scoped)

if (openAiKey === undefined || openAiKey === '' || anthropicKey === undefined || anthropicKey === '') {
	console.error('Set OPENAI_API_KEY and ANTHROPIC_API_KEY to run this example.')
	process.exitCode = 1
} else {
	Effect.runPromise(makeProgram(openAiKey, anthropicKey)).catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
