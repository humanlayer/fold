/**
 * RPI roster tests (design §3 "riptide-rpi"): the seven specialist types are load-bearing configuration
 * - exact names, delegation shape (only the implementers delegate, and only to the default roster's own
 * bash/general-purpose INSTANCES - identity is what keeps the combined registry free of duplicate-name
 * defects), profile-role model bindings, and the prompt-port guards (no Grep/Glob/TodoWrite/thoughts
 * residue anywhere; find/rg/grep-via-bash guidance exactly where the source named Grep/Glob/LS).
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

import {
	AST_GREP_OUTLINE_GUIDANCE,
	CODEBASE_ANALYZER_PROMPT,
	CODEBASE_LOCATOR_PROMPT,
	CODEBASE_PATTERN_FINDER_PROMPT,
	defaultCodingMode,
	defaultSubagents,
	IMPLEMENTATION_REVIEWER_PROMPT,
	IMPLEMENTER_AGENT_PROMPT,
	modeSubagents,
	OUTLINE_IMPLEMENTER_AGENT_PROMPT,
	rlmMode,
	rpiSubagents,
	WEB_SEARCH_RESEARCHER_PROMPT,
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

/** Mode tool context models (unused by the role-bound rosters, required by ModeToolContext). */
const models: ModeModels = {
	primary: namedModel('primary-model'),
	smart: namedModel('smart-model'),
	fast: namedModel('fast-model'),
	orchestrator: namedModel('orchestrator-model'),
}

const byNameIn = (definitions: ReadonlyArray<SubagentDefinition>, name: string): SubagentDefinition => {
	const found = definitions.find((definition) => definition.name === name)
	if (found === undefined) throw new Error(`no subagent named ${name}`)
	return found
}

const toolNames = (tools: ReadonlyArray<TartTool>): ReadonlyArray<string> => tools.map((tool) => tool.name)

/** The roster a definition may dispatch: the union of its subagentTool values' rosters. */
const dispatchableFrom = (definition: SubagentDefinition): ReadonlyArray<string> =>
	(definition.tools ?? []).flatMap((tool) => (subagentRosterOf(tool) ?? []).map((agent) => agent.name))

// Built ONCE at module scope: the identity assertions compare against these exact delegate instances.
const defaults = defaultSubagents({ cwd: '/tmp/project' })
const delegates = {
	bash: byNameIn(defaults, 'bash'),
	generalPurpose: byNameIn(defaults, 'general-purpose'),
}
const rpi = rpiSubagents({ cwd: '/tmp/project', delegates })

const RPI_NAMES = [
	'codebase-locator',
	'codebase-analyzer',
	'codebase-pattern-finder',
	'implementation-reviewer',
	'implementer-agent',
	'outline-implementer-agent',
	'web-search-researcher',
] as const

const rpiPrompts: Record<(typeof RPI_NAMES)[number], string> = {
	'codebase-locator': CODEBASE_LOCATOR_PROMPT,
	'codebase-analyzer': CODEBASE_ANALYZER_PROMPT,
	'codebase-pattern-finder': CODEBASE_PATTERN_FINDER_PROMPT,
	'implementation-reviewer': IMPLEMENTATION_REVIEWER_PROMPT,
	'implementer-agent': IMPLEMENTER_AGENT_PROMPT,
	'outline-implementer-agent': OUTLINE_IMPLEMENTER_AGENT_PROMPT,
	'web-search-researcher': WEB_SEARCH_RESEARCHER_PROMPT,
}

it('registers the seven RPI specialist types with their source names, unprefixed', () => {
	expect(rpi.map((definition) => definition.name)).toEqual([...RPI_NAMES])
})

it('binds the implementer types to smart and every other type to fast', () => {
	expect(byNameIn(rpi, 'implementer-agent').model).toBe('smart')
	expect(byNameIn(rpi, 'outline-implementer-agent').model).toBe('smart')

	for (const name of [
		'codebase-locator',
		'codebase-analyzer',
		'codebase-pattern-finder',
		'implementation-reviewer',
		'web-search-researcher',
	] as const) {
		expect(byNameIn(rpi, name).model, name).toBe('fast')
	}
})

// The four research/review types compose the shared ast-grep outline guidance as a SECOND leading
// block after their byte-faithful ported prompt; the implementers and web-search-researcher do not.
it('wires each exported prompt const onto its definition, with outline guidance on the research types', () => {
	for (const name of [
		'codebase-locator',
		'codebase-analyzer',
		'codebase-pattern-finder',
		'implementation-reviewer',
	] as const) {
		expect(byNameIn(rpi, name).systemPrompt, name).toEqual([rpiPrompts[name], AST_GREP_OUTLINE_GUIDANCE])
	}
	for (const name of ['implementer-agent', 'outline-implementer-agent', 'web-search-researcher'] as const) {
		expect(byNameIn(rpi, name).systemPrompt, name).toBe(rpiPrompts[name])
	}
})

it('the shared outline guidance names the command, the version floor, and the install path', () => {
	expect(AST_GREP_OUTLINE_GUIDANCE).toContain('ast-grep outline')
	expect(AST_GREP_OUTLINE_GUIDANCE).toContain('0.44.0')
	expect(AST_GREP_OUTLINE_GUIDANCE).toContain('npm i -g @ast-grep/cli')
	// Stays off the banned claude-code tool vocabulary like every ported prompt.
	expect(AST_GREP_OUTLINE_GUIDANCE).not.toMatch(/Grep|Glob|TodoWrite|thoughts\//)
})

it('gives codebase-locator bash only - no read tool and no way to delegate', () => {
	const locator = byNameIn(rpi, 'codebase-locator')

	expect(toolNames(locator.tools ?? [])).toEqual(['bash'])
	expect(dispatchableFrom(locator)).toEqual([])
})

it('gives the researcher leaves read + bash and no way to delegate', () => {
	for (const name of ['codebase-analyzer', 'codebase-pattern-finder', 'implementation-reviewer'] as const) {
		const definition = byNameIn(rpi, name)
		expect(toolNames(definition.tools ?? []), name).toEqual(['read', 'bash'])
		expect(dispatchableFrom(definition), name).toEqual([])
	}

	const webSearch = byNameIn(rpi, 'web-search-researcher')
	expect(toolNames(webSearch.tools ?? [])).toEqual(['bash', 'read'])
	expect(dispatchableFrom(webSearch)).toEqual([])
})

it('gives the implementers the full coding toolset and one subagent tool over the SHARED delegate instances', () => {
	for (const name of ['implementer-agent', 'outline-implementer-agent'] as const) {
		const definition = byNameIn(rpi, name)
		expect(toolNames(definition.tools ?? []), name).toEqual([
			'read',
			'write',
			'edit',
			'apply_patch',
			'bash',
			'subagent',
		])

		const rosters = (definition.tools ?? []).flatMap((tool) => {
			const roster = subagentRosterOf(tool)
			return roster === null ? [] : [roster]
		})
		expect(rosters, name).toHaveLength(1)
		expect(
			rosters[0]?.map((agent) => agent.name),
			name,
		).toEqual(['bash', 'general-purpose'])
		// The exact default-roster instances, by identity: this is what prevents the duplicate-type-name
		// session-start defect (the registry dedups by reference and dies on same-name distinct values).
		expect(rosters[0]?.[0], name).toBe(delegates.bash)
		expect(rosters[0]?.[1], name).toBe(delegates.generalPurpose)
	}
})

it('ports every prompt off the claude-code tool vocabulary', () => {
	for (const [name, prompt] of Object.entries(rpiPrompts)) {
		expect(prompt, name).not.toMatch(/Grep|Glob|TodoWrite|thoughts\//)
	}
})

// Only the prompts whose SOURCES name Grep/Glob/LS carry substituted guidance - and that guidance names
// the full trio (find / rg / grep via bash), not rg alone. Sources that name no tools gain none.
it('substitutes find / rg / grep via bash where the source named Grep/Glob/LS', () => {
	for (const prompt of [CODEBASE_LOCATOR_PROMPT, CODEBASE_PATTERN_FINDER_PROMPT]) {
		expect(prompt).toMatch(/\brg\b/)
		expect(prompt).toMatch(/\bfind\b|\bgrep\b/)
	}
})

it('keeps the documentarian-not-a-critic identity blocks on the three researcher types', () => {
	for (const prompt of [CODEBASE_LOCATOR_PROMPT, CODEBASE_ANALYZER_PROMPT, CODEBASE_PATTERN_FINDER_PROMPT]) {
		expect(prompt).toContain('You are a documentarian, not a critic or consultant')
	}
})

it('standardizes directory references to .humanlayer/tasks/', () => {
	expect(IMPLEMENTER_AGENT_PROMPT).toContain('.humanlayer/tasks/')
	expect(OUTLINE_IMPLEMENTER_AGENT_PROMPT).toContain('.humanlayer/tasks/')
	expect(IMPLEMENTATION_REVIEWER_PROMPT).toContain('.humanlayer/tasks/')
})

it('web-search-researcher plainly states it has no web tools and fetches with curl + llms.txt', () => {
	expect(WEB_SEARCH_RESEARCHER_PROMPT).toContain('NO WebSearch or WebFetch tool')
	expect(WEB_SEARCH_RESEARCHER_PROMPT).toContain('curl -sL')
	expect(WEB_SEARCH_RESEARCHER_PROMPT).toContain('llms.txt')
})

it('modeSubagents returns the default three without rpi and appends the seven with it', () => {
	expect(modeSubagents({ cwd: '/tmp/project', rpi: false }).map((definition) => definition.name)).toEqual([
		'general-purpose',
		'bash',
		'researcher',
	])
	expect(modeSubagents({ cwd: '/tmp/project', rpi: true }).map((definition) => definition.name)).toEqual([
		'general-purpose',
		'bash',
		'researcher',
		...RPI_NAMES,
	])
})

it.effect('the default mode with rpi flattens to exactly ten unique types - the shared-instance requirement', () =>
	Effect.gen(function* () {
		const rootTools = defaultCodingMode.buildTools({ cwd: '/tmp/project', models, rpi: true })
		const definitions = yield* collectSubagentDefinitions(rootTools)
		const names = definitions.map((definition) => definition.name)

		// collectSubagentDefinitions dies on a same-name duplicate across distinct definitions, so this
		// succeeding AND yielding ten unique names asserts the implementers reused the default instances.
		expect(names).toEqual(['general-purpose', 'bash', 'researcher', ...RPI_NAMES])
		expect(new Set(names).size).toBe(10)
	}),
)

it.effect('the rlm mode with rpi flattens to the same ten types and still has no root bash tool', () =>
	Effect.gen(function* () {
		const rootTools = rlmMode.buildTools({ cwd: '/tmp/project', models, rpi: true })

		expect(rootTools.map((tool) => tool.name)).not.toContain('bash')

		const definitions = yield* collectSubagentDefinitions(rootTools)
		expect(definitions.map((definition) => definition.name)).toEqual([
			'general-purpose',
			'bash',
			'researcher',
			...RPI_NAMES,
		])
	}),
)

it('installs no skill tool on any RPI agent (deliberate for v1)', () => {
	for (const definition of rpi) {
		expect(toolNames(definition.tools ?? []), definition.name).not.toContain('skill')
	}
})
