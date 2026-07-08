/**
 * Disk-backed skills example: SKILL.md files discovered through the standard scan chain - the user
 * directory (`~/.tart/skills`), the git repo root (`$REPO/.agents/skills`), and the working directory
 * (`$CWD/.agents/skills`), later roots shadowing earlier ones on duplicate names. To keep the demo
 * self-contained (and off your real home directory), it materializes a fake home and a fake repo in a
 * temp folder and points the loader at them - the exact override seam tests use.
 *
 * Run: ANTHROPIC_API_KEY=... bun packages/tart-agent/examples/SkillsFromDisk.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { anthropicModel, defineAgent, skillTool, startSession } from '@humanlayer/tart-core'
import { Console, Effect } from 'effect'

import { skillsFromDisk } from '../src/index'

const modelId = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'
const apiKey = process.env.ANTHROPIC_API_KEY

const skillFile = (name: string, description: string, body: string): string =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

/** Lay out a fake home + repo: one global skill, one repo skill that shadows a global duplicate. */
const materializeSkillTree = (): { readonly home: string; readonly cwd: string } => {
	const root = mkdtempSync(join(tmpdir(), 'tart-skills-demo-'))
	const home = join(root, 'home')
	const repo = join(root, 'repo')
	const cwd = join(repo, 'packages', 'app')

	// User directory: ~/.tart/skills
	mkdirSync(join(home, '.tart', 'skills', 'sign-off'), { recursive: true })
	writeFileSync(
		join(home, '.tart', 'skills', 'sign-off', 'SKILL.md'),
		skillFile(
			'sign-off',
			'How to sign off replies. Use for every reply.',
			'End every reply with "-- global tart".',
		),
	)

	// Git repo root: $REPO/.agents/skills (shadows the global sign-off).
	mkdirSync(join(repo, '.git'), { recursive: true })
	mkdirSync(join(repo, '.agents', 'skills', 'sign-off'), { recursive: true })
	writeFileSync(
		join(repo, '.agents', 'skills', 'sign-off', 'SKILL.md'),
		skillFile('sign-off', 'How to sign off replies. Use for every reply.', 'End every reply with "-- repo tart".'),
	)

	mkdirSync(cwd, { recursive: true })
	return { home, cwd }
}

const makeProgram = (apiKey: string) =>
	Effect.gen(function* () {
		const { home, cwd } = materializeSkillTree()
		yield* Console.log(`fake home: ${home}`)
		yield* Console.log(`fake cwd:  ${cwd}`)

		const session = yield* startSession({
			agent: defineAgent({
				name: 'disk-skills-demo',
				model: anthropicModel({ model: modelId, apiKey, reasoning: 'medium' }),
				systemPrompt: 'You are a tiny Tart demo agent.',
				// Omit home/cwd to scan the real chain (~/.tart/skills, repo root, process cwd).
				tools: [skillTool(skillsFromDisk({ home, cwd }))],
			}),
		})

		// The repo skill shadows the global one, so the model should sign off with "-- repo tart".
		const finished = yield* session.send('Load the sign-off skill and answer: what is 2 + 2?')

		yield* Console.log(`finished: ${finished.outcome}`)
		yield* Console.log(`result:\n${finished.resultText ?? '(no text)'}`)
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
