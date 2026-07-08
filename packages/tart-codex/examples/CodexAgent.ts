/**
 * Codex coding agent: the full coding toolset over a scratch workspace, running on the ChatGPT Codex
 * backend with OAuth credentials from ~/.tart/auth.json (copy your codex entry there, or run one of
 * the CodexAuth flows). The codex model family is shown read/apply_patch/bash - write/edit stay
 * hidden by the family policy - and streaming rides the hardened first-event/idle timeout + retry
 * pipeline.
 *
 * Run: bun packages/tart-codex/examples/CodexAgent.ts
 */
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { codingTools, jsonlEventLog } from '@humanlayer/tart-agent'
import { defineAgent, startSession } from '@humanlayer/tart-core'
import { Console, Effect } from 'effect'

import { codexModel } from '../src/index'

const modelId = process.env.TART_CODEX_MODEL ?? 'gpt-5.5'

const program = Effect.gen(function* () {
	const workspace = mkdtempSync(join(tmpdir(), 'tart-codex-demo-'))
	const logPath = join(workspace, 'session.jsonl')
	yield* Console.log(`workspace: ${workspace}`)

	const session = yield* startSession({
		agent: defineAgent({
			name: 'codex-demo',
			model: codexModel({ model: modelId, reasoning: 'medium' }),
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
			'Then use bash to print the file back with `cat greet.ts`.',
	)
	const entries = yield* session.entries

	yield* Console.log(`finished: ${finished.outcome}`)
	yield* Console.log(`result: ${finished.resultText ?? '(no text)'}`)
	yield* Console.log(`log rows: ${entries.length} (persisted to ${logPath})`)
	yield* Console.log(`tools used: ${entries.filter((entry) => entry._tag === 'tool-result').length} tool results`)
}).pipe(Effect.scoped)

Effect.runPromise(program).catch((error) => {
	console.error(`Set up codex credentials in ${join(homedir(), '.tart', 'auth.json')} before running.`)
	console.error(error)
	process.exitCode = 1
})
