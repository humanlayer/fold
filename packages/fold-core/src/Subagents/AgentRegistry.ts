/**
 * This file owns the session's flat agent-type registry (D21, round-five shape): the composition root
 * walks tools arrays from the root agent through every delegation tool's specialist and fork
 * definitions, and flattens everything reachable into one
 * name-keyed registry. Two concerns, two structures - each subagentTool value's closure gates
 * *dispatchability* for the agent holding it; the flat registry owns *state, ids, and resume* - so a
 * subagent is always resumable by id from one place while only the types in a dispatcher's roster are
 * launchable by it.
 */
import { Effect } from 'effect'

import { systemPromptBlocks } from '../Api/AgentDefinition'
import type { FoldTool } from '../Api/ToolDefinition'
import type { HookConfig } from '../HookRunner/Types'
import type { ForkAgentDefinition, ForkAgentDefinitionId } from './ForkAgentDefinition'
import type { SubagentDefinition, SubagentModelBinding } from './SubagentDefinition'
import { subagentCapabilitiesOf } from './SubagentTool'

/** Agent definitions reachable from a configured root toolset. */
export type CollectedAgentDefinitions<R = never> = {
	readonly subagents: ReadonlyArray<SubagentDefinition<R>>
	readonly forkAgents: ReadonlyArray<ForkAgentDefinition<R>>
}

/** One registered subagent type, resolved for runtime use. */
export type RegisteredAgentType = {
	readonly name: string
	readonly description: string
	/** Own leading prompt blocks, normalized from the definition (empty when it has none). */
	readonly systemPrompt: ReadonlyArray<string>
	/**
	 * The type's tools exactly as configured - its skillTool/subagentTool values included. The
	 * subagent operations realize session-initialized values from their session-start contributions
	 * when they provision this type's runtime; the roster and skill source are derivable from here.
	 * Every one has already been initialized, so their host services no longer matter here.
	 */
	readonly tools: ReadonlyArray<FoldTool<unknown>>
	/** Concrete model or profile role name; the subagent operations resolve roles per dispatch/resume. */
	readonly model: SubagentModelBinding<unknown>
	readonly hooks: HookConfig
}

/** The session-global flat registry of dispatchable agent types. */
export type AgentRegistry = {
	/** Look up one type by name; null when the session has no such type. */
	readonly resolveAgentType: (name: string) => RegisteredAgentType | null
	/** Every registered type, in first-reached order from the root's tools. */
	readonly entries: ReadonlyArray<RegisteredAgentType>
	/** Resolve one host-configured fork toolset by its durable identifier. */
	readonly resolveForkAgentDefinition: (id: ForkAgentDefinitionId) => ForkAgentDefinition<unknown> | null
	/**
	 * Add definitions discovered at an explicit session switch boundary. Existing names remain bound
	 * to their original session definition; duplicate names within the incoming graph have already
	 * been rejected by {@link collectAgentDefinitions}. Returns the specialist definitions actually added.
	 */
	readonly extend: (definitions: CollectedAgentDefinitions<unknown>) => ReadonlyArray<RegisteredAgentType>
}

/**
 * Walk tools arrays from the root, collecting every specialist and fork definition reachable through
 * delegation tools, in first-reached order.
 * Dedup is by object identity (sharing = passing the same definition by reference); the same name on
 * two distinct definitions is a configuration bug and dies. The seen-set makes traversal total even
 * if a definition graph is ever made circular through post-construction mutation.
 */
export const collectAgentDefinitions = <R>(
	rootTools: ReadonlyArray<FoldTool<R>>,
): Effect.Effect<CollectedAgentDefinitions<R>> =>
	Effect.suspend(() => {
		const seenSubagents = new Set<SubagentDefinition<R>>()
		const subagentsByName = new Map<string, SubagentDefinition<R>>()
		const subagents: Array<SubagentDefinition<R>> = []
		const seenForkAgents = new Set<ForkAgentDefinition<R>>()
		const forkAgentsById = new Map<ForkAgentDefinitionId, ForkAgentDefinition<R>>()
		const forkAgents: Array<ForkAgentDefinition<R>> = []

		const visitDefinition = (definition: SubagentDefinition<R>): Effect.Effect<void> => {
			if (seenSubagents.has(definition)) return Effect.void
			seenSubagents.add(definition)

			if (definition.name.trim().length === 0) {
				return Effect.die(new Error('subagent definitions must have a non-empty name'))
			}

			const existing = subagentsByName.get(definition.name)
			if (existing !== undefined && existing !== definition) {
				return Effect.die(
					new Error(`duplicate subagent type name "${definition.name}" across distinct definitions`),
				)
			}

			subagentsByName.set(definition.name, definition)
			subagents.push(definition)

			return visitTools(definition.tools ?? [])
		}

		const visitForkAgent = (definition: ForkAgentDefinition<R>): Effect.Effect<void> => {
			if (seenForkAgents.has(definition)) return Effect.void
			seenForkAgents.add(definition)

			if (definition.id.trim().length === 0) {
				return Effect.die(new Error('fork agent definitions must have a non-empty id'))
			}

			const existing = forkAgentsById.get(definition.id)
			if (existing !== undefined && existing !== definition) {
				return Effect.die(new Error(`duplicate fork agent definition id "${definition.id}"`))
			}

			forkAgentsById.set(definition.id, definition)
			forkAgents.push(definition)
			return visitTools(definition.tools)
		}

		const visitTools = (tools: ReadonlyArray<FoldTool<R>>): Effect.Effect<void> =>
			Effect.forEach(
				tools,
				(tool) => {
					const capabilities = subagentCapabilitiesOf(tool)
					if (capabilities === null) return Effect.void
					return Effect.all([
						Effect.forEach(capabilities.agents, visitDefinition, { discard: true }),
						capabilities.forkAgent === undefined ? Effect.void : visitForkAgent(capabilities.forkAgent),
					]).pipe(Effect.asVoid)
				},
				{ discard: true },
			)

		return visitTools(rootTools).pipe(Effect.as({ subagents, forkAgents }))
	})

/** Compatibility helper returning only registered specialist definitions. */
export const collectSubagentDefinitions = <R>(
	rootTools: ReadonlyArray<FoldTool<R>>,
): Effect.Effect<ReadonlyArray<SubagentDefinition<R>>> =>
	collectAgentDefinitions(rootTools).pipe(Effect.map((definitions) => definitions.subagents))

/** Build the flat registry over pre-collected (validated, deduped) definitions. */
export const agentRegistryFromDefinitions = (definitions: CollectedAgentDefinitions<unknown>): AgentRegistry => {
	const registeredFrom = (definition: SubagentDefinition<unknown>): RegisteredAgentType => ({
		name: definition.name,
		description: definition.description,
		systemPrompt: systemPromptBlocks(definition.systemPrompt),
		tools: definition.tools ?? [],
		model: definition.model,
		hooks: definition.hooks ?? {},
	})
	const entries: Array<RegisteredAgentType> = definitions.subagents.map(registeredFrom)
	const byName = new Map(entries.map((entry) => [entry.name, entry]))
	const definitionsByName = new Map(definitions.subagents.map((definition) => [definition.name, definition]))
	const forkAgentsById = new Map(definitions.forkAgents.map((definition) => [definition.id, definition]))

	return {
		resolveAgentType: (name) => byName.get(name) ?? null,
		resolveForkAgentDefinition: (id) => forkAgentsById.get(id) ?? null,
		entries,
		extend: (incoming) => {
			const added: Array<RegisteredAgentType> = []
			for (const definition of incoming.subagents) {
				const existing = definitionsByName.get(definition.name)
				// Mode rebuilds intentionally create fresh definition values for types already installed.
				// Keep the session's original binding; collectAgentDefinitions has still rejected two
				// distinct definitions with this name inside the incoming graph itself.
				if (existing !== undefined) continue
				const entry = registeredFrom(definition)
				definitionsByName.set(entry.name, definition)
				byName.set(entry.name, entry)
				entries.push(entry)
				added.push(entry)
			}
			for (const definition of incoming.forkAgents) {
				if (!forkAgentsById.has(definition.id)) forkAgentsById.set(definition.id, definition)
			}
			return added
		},
	}
}
