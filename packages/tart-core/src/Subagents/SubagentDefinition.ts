/**
 * This file defines the subagent type descriptor for the public API (D21, round-five shape). A subagent
 * definition is the full agent configuration minus the log: its own model/provider, hooks, prompt, and
 * `tools` - where its skill setup (`skillTool(...)`) and its roster of further dispatchable types
 * (`subagentTool([...])`) appear as ordinary tool values. Rosters therefore nest through tools arrays,
 * but the session flattens everything reachable into one flat registry - nesting scopes
 * *dispatchability*, never state; every dispatched subagent lives in one id space on one log.
 */
import type { TartModel } from '../Api/ModelDescriptor'
import type { TartTool } from '../Api/ToolDefinition'
import type { HookConfig } from '../HookRunner/Types'

/** Configuration for one subagent type, as plain data. Built with {@link defineSubagent}. */
export type SubagentDefinition = {
	/** Registry name; what the dispatching model passes as `agent`. Unique per session. */
	readonly name: string
	/** Feeds the dispatching agent's roster listing - what this type is for, model-facing. */
	readonly description: string
	/**
	 * This type's own leading prompt blocks, appended after the family base prompt - the same
	 * semantics as `defineAgent.systemPrompt` (append/compose; pi precedent, ruled 2026-07-07).
	 */
	readonly systemPrompt?: string | ReadonlyArray<string>
	/**
	 * Tools installed for this type: platform tools from `defineTool`, plus `skillTool(...)` for its
	 * skill setup and `subagentTool([...])` for the types IT may dispatch (no subagentTool means it
	 * cannot delegate at all). Sharing a system-tool value with another agent shares one setup.
	 */
	readonly tools?: ReadonlyArray<TartTool>
	/** This type's own hook chains (D16), independent of the root's and every other type's. */
	readonly hooks?: HookConfig
	/**
	 * The model this type runs on - explicit configuration, never chosen by the dispatching model and
	 * never inherited (ruled 2026-07-07). Profile names arrive with the profiles slice.
	 */
	readonly model: TartModel
}

/** Define one subagent type. Identity today; the single place type-config validation lands later. */
export const defineSubagent = (definition: SubagentDefinition): SubagentDefinition => definition
