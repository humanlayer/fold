/**
 * Facade tests for skills (D20/D24): the roster is read once at session start and rendered into the
 * leading system prompt plus the skill tool's description; the tool serves content on demand; adding a
 * skill mid-session never changes already-rendered prompt bytes (provider-cache stability); a model
 * switch carries the same session-start block into the new epoch's leading system message.
 */
import { expect, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'

import {
	defineAgent,
	skillSource,
	skillsFromData,
	startSession,
	type AgentStartedLogEntry,
	type SkillMeta,
	type SkillSourceService,
	type SystemMessageLogEntry,
	type ToolResultLogEntry,
} from '../../src/index'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { claudeActiveModel, gptActiveModel, scriptedModel } from './ApiTestHelpers'

const demoSkills = [
	{ name: 'commit-helper', description: 'Craft commit messages', content: 'Write conventional commits.' },
]

const leadingSystemBlocks = (entries: ReadonlyArray<{ readonly _tag: string }>): ReadonlyArray<string> =>
	entries
		.filter((entry): entry is SystemMessageLogEntry => entry._tag === 'system-message')
		.filter((entry) => entry.placement === 'leading')
		.map((entry) => entry.messages.map((message) => message.content).join('\n---\n'))

it.effect('renders the skills block into the leading prompt and installs the skill tool', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([{ id: 'provider-call-1', name: 'skill', params: { name: 'commit-helper' } }]),
			textTurn('loaded'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				model,
				systemPrompt: 'You are a demo agent.',
				skills: skillsFromData(demoSkills),
			}),
		})

		const finished = yield* session.send('use the commit skill')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')

		// The skills block is the trailing leading-prompt block, after the agent's own prompt.
		const blocks = leadingSystemBlocks(entries)
		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toContain('You are a demo agent.')
		expect(blocks[0]).toContain('<available_skills>')
		expect(blocks[0]).toContain('<name>commit-helper</name>')

		// The skill tool is installed and advertised to the model.
		const agentStarted = entries.find((entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started')
		expect(agentStarted?.tools).toContain('skill')
		const requests = yield* scripted.requests
		expect(requests[0]?.toolNames).toContain('skill')

		// The tool served the wrapped skill content.
		const toolResult = entries.find((entry): entry is ToolResultLogEntry => entry._tag === 'tool-result')
		const part = toolResult?.message.content[0]
		if (part === undefined || part.type !== 'tool-result') throw new Error('expected a tool-result part')
		expect(JSON.stringify(part.result)).toContain('<skill name=')
		expect(JSON.stringify(part.result)).toContain('Write conventional commits.')
	}),
)

it.effect('adding a skill mid-session never changes rendered prompt bytes; refresh reveals it', () =>
	Effect.gen(function* () {
		const roster = yield* Ref.make<ReadonlyArray<SkillMeta>>([
			{ name: 'commit-helper', description: 'Craft commit messages' },
		])
		const source: SkillSourceService = {
			list: Ref.get(roster),
			load: (name) => Effect.succeed({ name, description: 'x', content: `content of ${name}`, baseDir: null }),
		}

		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			textTurn('first'),
			toolCallTurn([{ id: 'provider-call-1', name: 'skill', params: { name: 'commit-helper', refresh: true } }]),
			textTurn('second'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model, systemPrompt: 'base', skills: skillSource(Effect.succeed(source)) }),
		})

		yield* session.send('hello')

		// A new skill appears on disk mid-session.
		yield* Ref.update(roster, (current) => [...current, { name: 'late-arrival', description: 'Added later' }])

		yield* session.send('load the skill with refresh')

		// Cache law: the system blocks of both requests are byte-identical - the new skill is invisible
		// in the prompt (the session-start snapshot rendered once).
		const requests = yield* scripted.requests
		const systemOf = (index: number) =>
			requests[index]?.prompt.content
				.filter((message) => message.role === 'system')
				.map((message) => message.content)
				.join('\n') ?? ''
		expect(systemOf(0)).not.toBe('')
		expect(systemOf(1)).toBe(systemOf(0))
		expect(systemOf(0)).not.toContain('late-arrival')

		// The refresh path reports the addition inside the tool result instead.
		const entries = yield* session.entries
		const toolResult = entries.find((entry): entry is ToolResultLogEntry => entry._tag === 'tool-result')
		const part = toolResult?.message.content[0]
		if (part === undefined || part.type !== 'tool-result') throw new Error('expected a tool-result part')
		expect(JSON.stringify(part.result)).toContain('Skills added since session start')
		expect(JSON.stringify(part.result)).toContain('late-arrival')
	}),
)

it.effect('a model switch carries the session-start skills block and skill tool into the new epoch', () =>
	Effect.gen(function* () {
		const first = yield* scriptedModel(gptActiveModel, [textTurn('from gpt')])
		const second = yield* scriptedModel(claudeActiveModel, [textTurn('from claude')])

		const session = yield* startSession({
			agent: defineAgent({ model: first.model, systemPrompt: 'base', skills: skillsFromData(demoSkills) }),
		})

		yield* session.send('one')
		yield* session.switchModel(second.model, { systemPrompt: 'switched base' })
		yield* session.send('two')

		const entries = yield* session.entries
		const blocks = leadingSystemBlocks(entries)

		// Both epochs carry the identical session-start skills block.
		expect(blocks).toHaveLength(2)
		expect(blocks[0]).toContain('<available_skills>')
		expect(blocks[1]).toContain('switched base')
		expect(blocks[1]).toContain('<available_skills>')

		// The new epoch still advertises the skill tool.
		const secondRequests = yield* second.scripted.requests
		expect(secondRequests[0]?.toolNames).toContain('skill')
	}),
)
