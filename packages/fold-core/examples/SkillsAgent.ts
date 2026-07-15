/**
 * Isomorphic skills example: skills passed in as data (no filesystem anywhere), so the same setup runs
 * in a browser, worker, or server. The roster is read once at session start - it renders into the
 * leading system prompt and the skill tool's description - and the model loads full skill content on
 * demand through the skill tool (progressive disclosure). See fold-agent's SkillsFromDisk example for the
 * disk-backed variant.
 *
 * Run: ANTHROPIC_API_KEY=... bun packages/fold-core/examples/SkillsAgent.ts
 */
import { Console, Effect } from 'effect'

import { anthropicModel, defineAgent, skillsFromData, skillTool, startSession } from '../src/index'

const modelId = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'
const apiKey = process.env.ANTHROPIC_API_KEY

const skills = skillsFromData([
	{
		name: 'haiku-reviews',
		description: 'Write code reviews as haiku. Use when the user asks for a poetic or haiku code review.',
		content: [
			'When reviewing code, respond with exactly one haiku (5-7-5 syllables).',
			'The first line names the problem, the second the consequence, the third the fix.',
			'Never explain the haiku.',
		].join('\n'),
	},
	{
		name: 'commit-messages',
		description: 'Craft conventional commit messages. Use when the user asks for a commit message.',
		content: 'Write commit messages as `type(scope): summary` with a body only when necessary.',
	},
])

const makeProgram = (apiKey: string) =>
	Effect.gen(function* () {
		const session = yield* startSession({
			agent: defineAgent({
				name: 'skills-demo',
				model: anthropicModel({ model: modelId, apiKey, reasoning: 'medium' }),
				systemPrompt: 'You are a tiny Fold demo agent.',
				tools: [skillTool(skills)],
			}),
		})

		const finished = yield* session.send(
			'Please give me a haiku code review of: `const x = JSON.parse(JSON.stringify(obj))`',
		)
		const entries = yield* session.entries

		yield* Console.log(`finished: ${finished.outcome}`)
		yield* Console.log(`result:\n${finished.resultText ?? '(no text)'}`)
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
