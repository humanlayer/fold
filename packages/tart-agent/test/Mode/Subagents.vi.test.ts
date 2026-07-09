/**
 * Default subagent roster tests (D21/D27): the shape of `defaultSubagents` is load-bearing configuration
 * - who may delegate to whom, and on which model - so it is asserted directly rather than through a
 * live session. The cycle test is the important one: `general-purpose` dispatches itself, so the
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

import { defaultCodingMode, defaultSubagents, type ModeModels } from '../../src/index'

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

/** Distinct model ids per role, so a definition's binding is observable. */
const models: ModeModels = {
	primary: namedModel('primary-model'),
	smart: namedModel('smart-model'),
	fast: namedModel('fast-model'),
	orchestrator: namedModel('orchestrator-model'),
}

const roster = (): ReadonlyArray<SubagentDefinition> => defaultSubagents({ cwd: '/tmp/project', models })

const byName = (name: string): SubagentDefinition => {
	const found = roster().find((definition) => definition.name === name)
	if (found === undefined) throw new Error(`no subagent named ${name}`)
	return found
}

const toolNames = (tools: ReadonlyArray<TartTool>): ReadonlyArray<string> => tools.map((tool) => tool.name)

/** The roster a definition may dispatch: the union of its subagentTool values' rosters. */
const dispatchableFrom = (definition: SubagentDefinition): ReadonlyArray<string> =>
	(definition.tools ?? []).flatMap((tool) => (subagentRosterOf(tool) ?? []).map((agent) => agent.name))

it('registers general-purpose, bash, and researcher', () => {
	expect(roster().map((definition) => definition.name)).toEqual(['general-purpose', 'bash', 'researcher'])
})

it('binds each type to its configured role model', () => {
	expect(byName('general-purpose').model.activeModel.modelId).toBe('smart-model')
	expect(byName('bash').model.activeModel.modelId).toBe('fast-model')
	expect(byName('researcher').model.activeModel.modelId).toBe('fast-model')
})

it('gives bash only the bash tool and no way to delegate', () => {
	const bash = byName('bash')
	expect(toolNames(bash.tools ?? [])).toEqual(['bash'])
	expect(dispatchableFrom(bash)).toEqual([])
})

it('gives researcher the full coding toolset plus skills, but no way to delegate', () => {
	const researcher = byName('researcher')
	expect(toolNames(researcher.tools ?? [])).toEqual(['read', 'write', 'edit', 'apply_patch', 'bash', 'skill'])
	expect(dispatchableFrom(researcher)).toEqual([])
})

it('lets general-purpose dispatch itself, bash, and researcher', () => {
	const generalPurpose = byName('general-purpose')
	expect(toolNames(generalPurpose.tools ?? [])).toEqual([
		'read',
		'write',
		'edit',
		'apply_patch',
		'bash',
		'skill',
		'subagent',
	])
	expect(dispatchableFrom(generalPurpose)).toEqual(['general-purpose', 'bash', 'researcher'])
})

it('exposes the whole roster to the root agent', () => {
	const rootTools = defaultCodingMode.buildTools({ cwd: '/tmp/project', models })
	const dispatchable = rootTools.flatMap((tool) => (subagentRosterOf(tool) ?? []).map((agent) => agent.name))
	expect(dispatchable).toEqual(['general-purpose', 'bash', 'researcher'])
})

// general-purpose's roster contains general-purpose: the registry walk must dedup by identity and
// terminate rather than recurse forever.
it.effect('collects a terminating flat registry despite the general-purpose self-cycle', () =>
	Effect.gen(function* () {
		const rootTools = defaultCodingMode.buildTools({ cwd: '/tmp/project', models })
		const definitions = yield* collectSubagentDefinitions(rootTools)

		expect(definitions.map((definition) => definition.name)).toEqual(['general-purpose', 'bash', 'researcher'])
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
