/**
 * This file defines the agent definition for the public API: what an agent is (model, system prompt,
 * tools, hooks), independent of where its session log lives or how its runtime is wired. One definition
 * can run against any event log backend, and the same definition's prompt blocks are recomposed when the
 * session switches models (D17).
 */
import { Match } from 'effect'

import type { AutoCompactConfig } from '../Compaction/CompactionService'
import type { HookConfig } from '../HookRunner/Types'
import type { ModelFamily } from '../Model/ModelFamily'
import type { StopConditionConfig } from '../StopConditions/StopConditions'
import type { FoldModel } from './ModelDescriptor'
import { toolsNeedingAll, type FoldTool, type FoldToolServices } from './ToolDefinition'

/** A leading system prompt as a host writes it: one block or an ordered set of blocks. */
export type SystemPromptInput = string | ReadonlyArray<string>

/**
 * Normalize a host-written system prompt to its ordered block list. Called once where a descriptor is
 * received (session start, model switch, registry build), so everything downstream sees blocks only.
 */
export const systemPromptBlocks = (systemPrompt: SystemPromptInput | undefined): ReadonlyArray<string> =>
	Match.value(systemPrompt).pipe(
		Match.when(Match.undefined, (): ReadonlyArray<string> => []),
		Match.when(Match.string, (block): ReadonlyArray<string> => [block]),
		Match.orElse((blocks) => blocks),
	)

/**
 * Configuration for one agent, as plain data. Built with {@link defineAgent}. `R` is every host service
 * its tools need; `startSession` requires them from its caller.
 */
export type AgentDefinition<R = never> = {
	/** Optional display name, recorded in `session_started` meta. */
	readonly name?: string
	/** The model the agent starts on. Sessions can switch later with `FoldSession.switchModel`. */
	readonly model: FoldModel<R>
	/** Stable provider cache-affinity key. Forked children derive and persist their own key from this one. */
	readonly promptCacheKey?: string
	/** The agent's own leading system prompt: one block or an ordered set of blocks. */
	readonly systemPrompt?: SystemPromptInput
	/**
	 * Tools installed for this agent, from {@link defineTool} and the system-tool factories: skills
	 * come from `skillTool(source)` and subagent dispatch from `subagentTool([...definitions])`, both
	 * ordinary members of this array (round-five ruling; the former `skills` field is removed -
	 * migrate `skills: src` to `tools: [..., skillTool(src)]`).
	 */
	readonly tools?: ReadonlyArray<FoldTool<R>>
	/** Hook configuration, run by this agent's HookRunner (D16). */
	readonly hooks?: HookConfig
	/**
	 * Family-keyed base prompts prepended before the agent's own blocks (D17). When the session switches
	 * to a model of a different family, the leading system prompt is recomposed with that family's base.
	 */
	readonly basePrompts?: Partial<Record<ModelFamily, string>>
	/**
	 * Auto-compaction policy (D11). Omitted means enabled with Fold defaults. When enabled, every agent in the session -
	 * root and subagents alike - compacts near its model's context limit: old history is summarized
	 * (pi's structured checkpoint template by default; `compactionPrompt` replaces it) into a durable
	 * `compaction` entry, and subsequent requests see the summary plus only the messages after the cut.
	 */
	readonly autoCompact?: AutoCompactConfig
	/** Runtime stop-condition policy. Omitted means no host-level stop conditions are installed. */
	readonly stopConditions?: StopConditionConfig
}

/** {@link AgentDefinition} as written by a caller: its tools keep their own types. */
export type AgentDefinitionInput<T extends FoldTool<unknown>, RM> = Omit<AgentDefinition, 'tools' | 'model'> & {
	readonly model: FoldModel<RM>
	readonly tools?: ReadonlyArray<T>
}

/**
 * Define one agent. The agent needs its model's services plus the union of its tools'. The single place
 * agent-config validation lands later.
 */
export const defineAgent = <T extends FoldTool<unknown> = FoldTool, RM = never>(
	definition: AgentDefinitionInput<T, RM>,
): AgentDefinition<FoldToolServices<T> | RM> => {
	const { tools, ...rest } = definition
	return tools === undefined ? rest : { ...rest, tools: toolsNeedingAll(tools) }
}
