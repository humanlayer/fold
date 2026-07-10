/**
 * Default subagent roster tests (D21/D27): the shape of `defaultSubagents` is load-bearing configuration
 * - who may delegate to whom, and on which profile role - so it is asserted directly rather than through
 * a live session. The cycle test is the important one: `general-purpose` dispatches itself, so the
 * registry walk must terminate.
 */
import { expect, it } from '@effect/vitest'
import {
	collectSubagentDefinitions,
	customModel,
	subagentRosterOf,
	type ActiveModel,
	type SubagentDefinition,
	type TartModel,
	type TartTool,
} from '@humanlayer/tart-core'
import { Effect, Stream } from 'effect'
import { LanguageModel } from 'effect/unstable/ai'

import { AST_GREP_OUTLINE_GUIDANCE, defaultCodingMode, defaultSubagents, type ModeModels } from '../../src/index'

const namedModel = (modelId: string): TartModel => {
	const activeModel: ActiveModel = {
		providerId: 'test',
		providerKind: 'openai-compatible',
		modelId,
		role: null,
		requestedReasoningLevel: 'off',
		reasoning: { _tag: 'disabled' },
	}

	return customModel({
		activeModel,
		make: LanguageModel.make({
			generateText: () => Effect.die(new Error('unused')),
			streamText: () => Stream.empty,
		}),
	})
}

/** Mode tool context models (unused by the role-bound default roster, required by ModeToolContext). */
const models: ModeModels = {
	primary: namedModel('primary-model'),
	smart: namedModel('smart-model'),
	fast: namedModel('fast-model'),
	orchestrator: namedModel('orchestrator-model'),
}

const roster = (): ReadonlyArray<SubagentDefinition> => defaultSubagents({ cwd: '/tmp/project' })

const byName = (name: string): SubagentDefinition => {
	const found = roster().find((definition) => definition.name === name)
	if (found === undefined) throw new Error(`no subagent named ${name}`)
	return found
}

const toolNames = (tools: ReadonlyArray<TartTool>): ReadonlyArray<string> => tools.map((tool) => tool.name)

/** The roster a definition may dispatch: the union of its subagentTool values' rosters. */
const dispatchableFrom = (definition: SubagentDefinition): ReadonlyArray<string> =>
	(definition.tools ?? []).flatMap((tool) => (subagentRosterOf(tool) ?? []).map((agent) => agent.name))

it('registers general-purpose, bash, researcher, and web-search-researcher', () => {
	expect(roster().map((definition) => definition.name)).toEqual([
		'general-purpose',
		'bash',
		'researcher',
		'web-search-researcher',
	])
})

it('binds each type to its profile role (resolved through the session profiles map, not here)', () => {
	expect(byName('general-purpose').model).toBe('smart')
	expect(byName('bash').model).toBe('fast')
	expect(byName('researcher').model).toBe('fast')
	expect(byName('web-search-researcher').model).toBe('fast')
})

it('gives bash only the bash tool and no way to delegate', () => {
	const bash = byName('bash')
	expect(toolNames(bash.tools ?? [])).toEqual(['bash'])
	expect(dispatchableFrom(bash)).toEqual([])
})

// The 2026-07-09 ruling reversal: researcher is a documentarian, so it holds NO editing capability at
// all - read + bash + skill only - rather than a full toolset it is merely told not to use.
it('gives researcher read + bash + skill only - no editing tools, no way to delegate', () => {
	const researcher = byName('researcher')
	const names = toolNames(researcher.tools ?? [])

	expect(names).toEqual(['read', 'bash', 'skill'])
	for (const editing of ['write', 'edit', 'apply_patch'] as const) {
		expect(names, editing).not.toContain(editing)
	}
	expect(dispatchableFrom(researcher)).toEqual([])
	// The shared ast-grep outline guidance rides as a second leading block after the ported prompt.
	expect(Array.isArray(researcher.systemPrompt)).toBe(true)
	if (Array.isArray(researcher.systemPrompt)) {
		expect(researcher.systemPrompt.at(-1)).toBe(AST_GREP_OUTLINE_GUIDANCE)
	}
})

it('gives web-search-researcher web tools only and no way to delegate', () => {
	const webSearchResearcher = byName('web-search-researcher')
	expect(toolNames(webSearchResearcher.tools ?? [])).toEqual(['web_fetch', 'web_search'])
	expect(dispatchableFrom(webSearchResearcher)).toEqual([])
})

it('lets general-purpose dispatch itself, bash, researcher, and web-search-researcher', () => {
	const generalPurpose = byName('general-purpose')
	expect(toolNames(generalPurpose.tools ?? [])).toEqual([
		'read',
		'write',
		'edit',
		'apply_patch',
		'bash',
		'web_fetch',
		'web_search',
		'skill',
		'subagent',
	])
	expect(dispatchableFrom(generalPurpose)).toEqual(['general-purpose', 'bash', 'researcher', 'web-search-researcher'])
})

it('exposes the whole roster to the root agent', () => {
	const rootTools = defaultCodingMode.buildTools({ cwd: '/tmp/project', models, rpi: false })
	const dispatchable = rootTools.flatMap((tool) => (subagentRosterOf(tool) ?? []).map((agent) => agent.name))
	expect(dispatchable).toEqual(['general-purpose', 'bash', 'researcher', 'web-search-researcher'])
})

// general-purpose's roster contains general-purpose: the registry walk must dedup by identity and
// terminate rather than recurse forever.
it.effect('collects a terminating flat registry despite the general-purpose self-cycle', () =>
	Effect.gen(function* () {
		const rootTools = defaultCodingMode.buildTools({ cwd: '/tmp/project', models, rpi: false })
		const definitions = yield* collectSubagentDefinitions(rootTools)

		expect(definitions.map((definition) => definition.name)).toEqual([
			'general-purpose',
			'bash',
			'researcher',
			'web-search-researcher',
		])
	}),
)

it('shares one skill source across the agents that get skills (one session-start scan)', () => {
	const definitions = roster()
	const skillValues = definitions.flatMap((definition) =>
		(definition.tools ?? []).filter((tool) => tool.name === 'skill'),
	)

	expect(skillValues).toHaveLength(2)
	expect(skillValues[0]).toBe(skillValues[1])
})
