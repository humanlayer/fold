import type { Effect, Scope } from 'effect'

/**
 * This file defines the subagent type descriptor for the public API (D21, round-five shape). A subagent
 * definition is the full agent configuration minus the log: its own model/provider, hooks, prompt, and
 * `tools` - where its skill setup (`skillTool(...)`) and its roster of further dispatchable types
 * (`subagentTool([...])`) appear as ordinary tool values. Rosters therefore nest through tools arrays,
 * but the session flattens everything reachable into one flat registry - nesting scopes
 * *dispatchability*, never state; every dispatched subagent lives in one id space on one log.
 */
import type { SystemPromptInput } from '../Api/AgentDefinition'
import type { FoldModel } from '../Api/ModelDescriptor'
import { toolsNeedingAll, type FoldTool, type FoldToolServices } from '../Api/ToolDefinition'
import type { HookConfig } from '../HookRunner/Types'
import type { ProfileRole } from '../Session/Profiles'

/**
 * How a subagent type's model is configured: a concrete model descriptor, or a profile role name
 * resolved through the session's profiles map at every dispatch/resume (profiles slice). Role-bound
 * types follow `FoldSession.setProfile` swaps on their very next run; `Session.open`
 * must receive a `profiles` map covering every role the roster names (`orchestrator` falls back to
 * `smart`, D25).
 */
export type SubagentModelBinding<R = never> = FoldModel<R> | ProfileRole

/**
 * Configuration for one subagent type, as plain data. Built with {@link defineSubagent}. `R` is every
 * host service its tools need.
 */
export type SubagentDefinition<R = never> = {
	/** Registry name; what the dispatching model passes as `agent`. Unique per session. */
	readonly name: string
	/** Feeds the dispatching agent's roster listing - what this type is for, model-facing. */
	readonly description: string
	/**
	 * This type's own leading prompt blocks, appended after the family base prompt - the same
	 * semantics as `defineAgent.systemPrompt` (append/compose; pi precedent, ruled 2026-07-07).
	 */
	readonly systemPrompt?: SystemPromptInput
	/**
	 * Tools installed for this type: platform tools from `defineTool`, plus `skillTool(...)` for its
	 * skill setup and `subagentTool([...])` for the types IT may dispatch (no subagentTool means it
	 * cannot delegate at all). Sharing a system-tool value with another agent shares one setup.
	 */
	readonly tools?: ReadonlyArray<FoldTool<R>>
	/** This type's own hook chains (D16), independent of the root's and every other type's. */
	readonly hooks?: HookConfig
	/**
	 * The model this type runs on - explicit configuration, never chosen by the dispatching model and
	 * never inherited (ruled 2026-07-07). Either a concrete model descriptor, or a profile role name
	 * (`'smart' | 'fast' | 'orchestrator'`) resolved through the session's profiles map at each
	 * dispatch/resume, so one `setProfile` swap moves every role-bound type together.
	 */
	readonly model: SubagentModelBinding<R>
}

/** {@link SubagentDefinition} as written by a caller: its tools keep their own types. */
export type SubagentDefinitionInput<T extends FoldTool<unknown>, RM> = Omit<SubagentDefinition, 'tools' | 'model'> & {
	readonly model: SubagentModelBinding<RM>
	readonly tools?: ReadonlyArray<T>
}

/** The host services a model binding needs; a profile role needs none of its own. */
type ModelBindingServices<B> = B extends { readonly make: Effect.Effect<infer _A, infer _E, infer R> }
	? Exclude<R, Scope.Scope>
	: never

/** The host services a subagent definition, or a union of them, needs: its tools' and its model's. */
export type SubagentDefinitionServices<D> = D extends {
	readonly tools?: ReadonlyArray<infer T>
	readonly model: infer B
}
	? FoldToolServices<T> | ModelBindingServices<B>
	: never

/**
 * Define one subagent type; it needs the union of its tools' services. The single place type-config
 * validation lands later.
 */
export const defineSubagent = <T extends FoldTool<unknown> = FoldTool, RM = never>(
	definition: SubagentDefinitionInput<T, RM>,
): SubagentDefinition<FoldToolServices<T> | RM> => {
	const { tools, ...rest } = definition
	return tools === undefined ? rest : { ...rest, tools: toolsNeedingAll(tools) }
}

/** View a list of subagent definitions as definitions needing the union of their services. */
export const subagentsNeedingAll = <D extends SubagentDefinition<unknown>>(
	definitions: ReadonlyArray<D>,
): ReadonlyArray<SubagentDefinition<SubagentDefinitionServices<D>>> =>
	// SAFETY: each element is a SubagentDefinition<R> whose R is one member of SubagentDefinitionServices<D>,
	// and SubagentDefinition is covariant in R. TypeScript cannot see through the conditional type for a
	// generic D.
	// oxlint-disable-next-line typescript/consistent-type-assertions, automation/no-type-assertion
	definitions as ReadonlyArray<SubagentDefinition<SubagentDefinitionServices<D>>>
