/**
 * RLM mode tests (D21/D27): the orchestrator's toolset is load-bearing configuration - deliberately NO
 * bash on the root, one subagent tool carrying the default roster, and the strengthened orchestrator
 * prompt - so it is asserted directly, like the default roster in Subagents.vi.test.ts.
 */
import { expect, it } from '@effect/vitest'
import {
	collectSubagentDefinitions,
	customModel,
	type ActiveModel,
	type TartModel,
	type TartTool,
} from '@humanlayer/tart-core'
import { Effect, Stream } from 'effect'
import { LanguageModel } from 'effect/unstable/ai'

import {
	defaultCodingMode,
	modeForName,
	RLM_ORCHESTRATOR_PROMPT,
	rlmMode,
	TART_MODE_NAMES,
	type ModeModels,
} from '../../src/index'

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

const models: ModeModels = {
	primary: namedModel('primary-model'),
	smart: namedModel('smart-model'),
	fast: namedModel('fast-model'),
	orchestrator: namedModel('orchestrator-model'),
}

const rlmTools = (): ReadonlyArray<TartTool> => rlmMode.buildTools({ cwd: '/tmp/project', models })

const toolNames = (tools: ReadonlyArray<TartTool>): ReadonlyArray<string> => tools.map((tool) => tool.name)

it('is named rlm and runs on the orchestrator role', () => {
	expect(rlmMode.name).toBe('rlm')
	expect(rlmMode.role).toBe('orchestrator')
	expect(rlmMode.systemPrompt).toBe(RLM_ORCHESTRATOR_PROMPT)
})

it('holds the file tools, skills, and subagents - and deliberately no bash', () => {
	const names = toolNames(rlmTools())

	expect(names).not.toContain('bash')
	expect(names.filter((name) => name === 'subagent')).toHaveLength(1)
	expect(names.filter((name) => name === 'skill')).toHaveLength(1)
	expect(names).toContain('read')
	expect(names).toContain('write')
	expect(names).toContain('edit')
	expect(names).toContain('apply_patch')
})

it.effect('exposes the default roster to the orchestrator', () =>
	Effect.gen(function* () {
		const definitions = yield* collectSubagentDefinitions(rlmTools())

		expect(definitions.map((definition) => definition.name)).toEqual(['general-purpose', 'bash', 'researcher'])
	}),
)

it('maps mode names to mode values', () => {
	expect(TART_MODE_NAMES).toEqual(['default', 'rlm'])
	expect(modeForName('default')).toBe(defaultCodingMode)
	expect(modeForName('rlm')).toBe(rlmMode)
})

it('instructs delegation and states the no-bash rule', () => {
	expect(RLM_ORCHESTRATOR_PROMPT).toContain('delegating work to sub-agents')
	expect(RLM_ORCHESTRATOR_PROMPT).toContain('NO bash')
	expect(RLM_ORCHESTRATOR_PROMPT).toContain('`subagent`')
	expect(RLM_ORCHESTRATOR_PROMPT).toContain('general-purpose')
	expect(RLM_ORCHESTRATOR_PROMPT).toContain('researcher')
})
