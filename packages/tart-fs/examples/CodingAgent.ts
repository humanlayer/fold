/**
 * Filesystem coding agent: the full coding toolset (read, write, edit, apply_patch, bash) over a
 * scratch workspace, with the session log persisted as JSONL. The claude-family model is shown
 * write/edit (apply_patch stays hidden by the family policy); switching to a gpt/codex-family model
 * mid-session would flip the advertised editing tools automatically.
 *
 * Run: ANTHROPIC_API_KEY=... bun packages/tart-fs/examples/CodingAgent.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { anthropicModel, defineAgent, startSession } from '@humanlayer/tart-core'
import { Console, Effect } from 'effect'

import { codingTools, jsonlEventLog } from '../src/index'

const modelId = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'
const apiKey = process.env.ANTHROPIC_API_KEY

const makeProgram = (apiKey: string) =>
	Effect.gen(function* () {
		const workspace = mkdtempSync(join(tmpdir(), 'tart-coding-demo-'))
		const logPath = join(workspace, 'session.jsonl')
		yield* Console.log(`workspace: ${workspace}`)

		const session = yield* startSession({
			agent: defineAgent({
				name: 'coding-demo',
				model: anthropicModel({ model: modelId, apiKey, reasoning: 'medium' }),
				systemPrompt:
					'You are a small coding agent working in the current directory. ' +
					'Use your tools to inspect and change files; keep answers short.',
				tools: codingTools({ cwd: workspace }),
			}),
			log: jsonlEventLog(logPath),
			cwd: workspace,
		})

		const finished = yield* session.send(
			'Create a file called greet.ts exporting `greet(name: string): string` returning "hello, {name}". ' +
				'Then use bash to print the file back with `cat greet.ts`, and finally change the greeting to "howdy" with an edit.',
		)
		const entries = yield* session.entries

		yield* Console.log(`finished: ${finished.outcome}`)
		yield* Console.log(`result: ${finished.resultText ?? '(no text)'}`)
		yield* Console.log(`log rows: ${entries.length} (persisted to ${logPath})`)
		yield* Console.log(`tools used: ${entries.filter((entry) => entry._tag === 'tool-result').length} tool results`)
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
