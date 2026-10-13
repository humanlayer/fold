/**
 * Codex coding agent: the full coding toolset over a scratch workspace, running on the ChatGPT Codex
 * backend with OAuth credentials from ~/.fold/auth.json (copy your codex entry there, or run one of
 * the CodexAuth flows). The codex model family is shown read/apply_patch/bash - write/edit stay
 * hidden by the family policy - and streaming rides the hardened first-event/idle timeout + retry
 * pipeline.
 *
 * Run: bun packages/fold-agent/examples/CodexAgent.ts
 */
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { codexModel } from '@humanlayer/fold-codex'
import { defineAgent, Session } from '@humanlayer/fold-core'
import { Predicate, Console, Effect, Layer } from 'effect'

import { codingTools, layerJsonl, layerCodingToolServices } from '../src/index'

const modelId = process.env.FOLD_CODEX_MODEL ?? 'gpt-5.5'

const program = Effect.gen(function* () {
	const workspace = mkdtempSync(join(tmpdir(), 'fold-codex-demo-'))
	const logPath = join(workspace, 'session.jsonl')
	yield* Console.log(`workspace: ${workspace}`)

	// The coding tools' services live as long as the session, in this program's scope.
	const toolServices = yield* Layer.build(
		layerJsonl(logPath).pipe(
			Layer.orDie,
			Layer.provideMerge(layerCodingToolServices({ outputDirectory: join(workspace, 'tool-output') })),
		),
	)
	const session = yield* Session.open({
		agent: defineAgent({
			name: 'codex-demo',
			model: codexModel({ model: modelId, reasoning: 'medium' }),
			systemPrompt:
				'You are a small coding agent working in the current directory. ' +
				'Use your tools to inspect and change files; keep answers short.',
			tools: codingTools({ cwd: workspace }),
		}),
		cwd: workspace,
	}).pipe(Effect.provideContext(toolServices))

	const finished = yield* session.send(
		'Create a file called greet.ts exporting `greet(name: string): string` returning "hello, {name}". ' +
			'Then use bash to print the file back with `cat greet.ts`.',
	)
	const entries = yield* session.entries

	yield* Console.log(`finished: ${finished.outcome}`)
	yield* Console.log(`result: ${finished.resultText ?? '(no text)'}`)
	yield* Console.log(`log rows: ${entries.length} (persisted to ${logPath})`)
	yield* Console.log(
		`tools used: ${entries.filter((entry) => Predicate.isTagged(entry, 'tool-result')).length} tool results`,
	)
}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))

Effect.runPromise(program).catch((error) => {
	console.error(`Set up codex credentials in ${join(homedir(), '.fold', 'auth.json')} before running.`)
	console.error(error)
	process.exitCode = 1
})
