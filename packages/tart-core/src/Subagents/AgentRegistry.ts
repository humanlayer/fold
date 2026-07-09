/**
 * This file owns the session's flat agent-type registry (D21, round-five shape): the composition root
 * walks tools arrays from the root agent, following every `subagentTool([...])` value into the
 * definitions it carries (and recursing into THEIR tools), and flattens everything reachable into one
 * name-keyed registry. Two concerns, two structures - each subagentTool value's closure gates
 * *dispatchability* for the agent holding it; the flat registry owns *state, ids, and resume* - so a
 * subagent is always resumable by id from one place while only the types in a dispatcher's roster are
 * launchable by it.
 */
import { Effect } from 'effect'

import type { TartTool } from '../Api/ToolDefinition'
import type { HookConfig } from '../HookRunner/Types'
import type { SubagentDefinition, SubagentModelBinding } from './SubagentDefinition'
import { subagentRosterOf } from './SubagentTool'

/** One registered subagent type, resolved for runtime use. */
export type RegisteredAgentType = {
	readonly name: string
	readonly description: string
	readonly systemPrompt: string | ReadonlyArray<string> | null
	/**
	 * The type's tools exactly as configured - its skillTool/subagentTool values included. The
	 * Subagents service realizes session-initialized values from their session-start contributions
	 * when it provisions this type's runtime; the roster and skill source are derivable from here.
	 */
	readonly tools: ReadonlyArray<TartTool>
	/** Concrete model or profile role name; the Subagents engine resolves roles per dispatch/resume. */
	readonly model: SubagentModelBinding
	readonly hooks: HookConfig
}

/** The session-global flat registry of dispatchable agent types. */
export type AgentRegistry = {
	/** Look up one type by name; null when the session has no such type. */
	readonly resolveAgentType: (name: string) => RegisteredAgentType | null
	/** Every registered type, in first-reached order from the root's tools. */
	readonly entries: ReadonlyArray<RegisteredAgentType>
}

/**
 * Walk tools arrays from the root, collecting every subagent definition reachable through
 * `subagentTool` values (recursing into each definition's own tools), in first-reached order.
 * Dedup is by object identity (sharing = passing the same definition by reference); the same name on
 * two distinct definitions is a configuration bug and dies. The seen-set makes traversal total even
 * if a definition graph is ever made circular through post-construction mutation.
 */
export const collectSubagentDefinitions = (
	rootTools: ReadonlyArray<TartTool>,
): Effect.Effect<ReadonlyArray<SubagentDefinition>> =>
	Effect.suspend(() => {
		const seen = new Set<SubagentDefinition>()
		const byName = new Map<string, SubagentDefinition>()
		const ordered: Array<SubagentDefinition> = []

		const visitDefinition = (definition: SubagentDefinition): Effect.Effect<void> => {
			if (seen.has(definition)) return Effect.void
			seen.add(definition)

			if (definition.name.trim().length === 0) {
				return Effect.die(new Error('subagent definitions must have a non-empty name'))
			}

			const existing = byName.get(definition.name)
			if (existing !== undefined && existing !== definition) {
				return Effect.die(
					new Error(`duplicate subagent type name "${definition.name}" across distinct definitions`),
				)
			}

			byName.set(definition.name, definition)
			ordered.push(definition)

			return visitTools(definition.tools ?? [])
		}

		const visitTools = (tools: ReadonlyArray<TartTool>): Effect.Effect<void> =>
			Effect.forEach(
				tools,
				(tool) => {
					const roster = subagentRosterOf(tool)
					return roster === null ? Effect.void : Effect.forEach(roster, visitDefinition, { discard: true })
				},
				{ discard: true },
			)

		return visitTools(rootTools).pipe(Effect.as(ordered))
	})

/** Build the flat registry over pre-collected (validated, deduped) definitions. */
export const agentRegistryFromDefinitions = (definitions: ReadonlyArray<SubagentDefinition>): AgentRegistry => {
	const entries: ReadonlyArray<RegisteredAgentType> = definitions.map((definition) => ({
		name: definition.name,
		description: definition.description,
		systemPrompt: definition.systemPrompt ?? null,
		tools: definition.tools ?? [],
		model: definition.model,
		hooks: definition.hooks ?? {},
	}))
	const byName = new Map(entries.map((entry) => [entry.name, entry]))

	return {
		resolveAgentType: (name) => byName.get(name) ?? null,
		entries,
	}
}
