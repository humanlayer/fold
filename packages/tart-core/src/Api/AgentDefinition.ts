/**
 * This file defines the agent definition for the public API: what an agent is (model, system prompt,
 * tools, hooks), independent of where its session log lives or how its runtime is wired. One definition
 * can run against any event log backend, and the same definition's prompt blocks are recomposed when the
 * session switches models (D17).
 */
import type { HookConfig } from '../HookRunner/Types'
import type { ModelFamily } from '../Model/ModelFamily'
import type { TartModel } from './ModelDescriptor'
import type { TartTool } from './ToolDefinition'

/** Configuration for one agent, as plain data. Built with {@link defineAgent}. */
export type AgentDefinition = {
	/** Optional display name, recorded in `session_started` meta. */
	readonly name?: string
	/** The model the agent starts on. Sessions can switch later with `TartSession.switchModel`. */
	readonly model: TartModel
	/** The agent's own leading system prompt: one block or an ordered set of blocks. */
	readonly systemPrompt?: string | ReadonlyArray<string>
	/**
	 * Tools installed for this agent, from {@link defineTool} and the system-tool factories: skills
	 * come from `skillTool(source)` and subagent dispatch from `subagentTool([...definitions])`, both
	 * ordinary members of this array (round-five ruling; the former `skills` field is removed -
	 * migrate `skills: src` to `tools: [..., skillTool(src)]`).
	 */
	readonly tools?: ReadonlyArray<TartTool>
	/** Hook configuration, run by this agent's HookRunner (D16). */
	readonly hooks?: HookConfig
	/**
	 * Family-keyed base prompts prepended before the agent's own blocks (D17). When the session switches
	 * to a model of a different family, the leading system prompt is recomposed with that family's base.
	 */
	readonly basePrompts?: Partial<Record<ModelFamily, string>>
}

/** Define one agent. Identity today; the single place agent-config validation lands later. */
export const defineAgent = (definition: AgentDefinition): AgentDefinition => definition
