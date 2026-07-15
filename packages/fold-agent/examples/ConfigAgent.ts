/**
 * Config-driven coding agent (D25/D27): the batteries-included launch path the CLI/OpenTUI will use.
 * Loads `~/.fold/config.jsonc` (writing a commented starter on first run), resolves the mode's `smart`
 * role to a model, folds this directory's agentfiles (AGENTS.md/CLAUDE.md) into the system prompt, and
 * runs the default coding mode over a JSONL session log under `~/.fold/sessions`.
 *
 * First run:  bun packages/fold-agent/examples/ConfigAgent.ts
 *   -> writes ~/.fold/config.jsonc; edit providers/roles, export the referenced API key env var, re-run.
 * Then:       bun packages/fold-agent/examples/ConfigAgent.ts "your prompt"
 */
import { Console, Effect } from 'effect'

import { configInit, launchSession, loadFoldConfigOrNull } from '../src/index'

const prompt = process.argv[2] ?? 'List the files in the current directory and briefly summarize this project.'

const program = Effect.gen(function* () {
	const config = yield* loadFoldConfigOrNull()
	if (config === null) {
		const init = yield* configInit()
		yield* Console.log(`No config found - wrote a starter to ${init.configPath}`)
		yield* Console.log('Edit its providers/roles, export the referenced API key env var, then re-run.')
		return
	}

	const session = yield* launchSession({ config })
	yield* Console.log(`session ${session.sessionId} started; sending prompt...\n`)

	const finished = yield* session.send(prompt)
	yield* Console.log(`\n[${finished.outcome}] ${finished.resultText ?? '(no text)'}`)
}).pipe(Effect.scoped)

Effect.runPromise(program).catch((error) => {
	console.error(error)
	process.exitCode = 1
})
