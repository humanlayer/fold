/**
 * Codex/gpt-family editing example: the same coding toolset as CodingAgent, but on a gpt-family model
 * the ToolsetResolver hides write/edit and advertises apply_patch instead - the model edits files by
 * emitting V4A patches (raw git/unified diffs are accepted too). Nothing tool-side changes between
 * families; only the advertised subset flips.
 *
 * Run: OPENAI_API_KEY=... bun packages/tart-fs/examples/ApplyPatchAgent.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineAgent, openaiModel, startSession } from '@humanlayer/tart-core'
import { Console, Effect } from 'effect'

import { codingTools } from '../src/index'

const modelId = process.env.OPENAI_MODEL ?? 'gpt-5.5'
const apiKey = process.env.OPENAI_API_KEY

const makeProgram = (apiKey: string) =>
	Effect.gen(function* () {
		const workspace = mkdtempSync(join(tmpdir(), 'tart-patch-demo-'))
		writeFileSync(join(workspace, 'config.json'), '{\n  "retries": 1,\n  "verbose": false\n}\n')
		yield* Console.log(`workspace: ${workspace}`)

		const session = yield* startSession({
			agent: defineAgent({
				name: 'apply-patch-demo',
				model: openaiModel({ model: modelId, apiKey, reasoning: 'medium' }),
				systemPrompt:
					'You are a small coding agent working in the current directory. ' +
					'Read files before patching them; keep answers short.',
				tools: codingTools({ cwd: workspace }),
			}),
			cwd: workspace,
		})

		const finished = yield* session.send(
			'Read config.json, then use apply_patch to set "retries" to 3 and read it back to confirm.',
		)
		const entries = yield* session.entries
		const toolNames = entries.flatMap((entry) =>
			entry._tag === 'tool-result'
				? [entry.message.content[0]?.type === 'tool-result' ? entry.message.content[0].name : '']
				: [],
		)

		yield* Console.log(`finished: ${finished.outcome}`)
		yield* Console.log(`result: ${finished.resultText ?? '(no text)'}`)
		yield* Console.log(`tools called: ${toolNames.join(', ')}`)
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
