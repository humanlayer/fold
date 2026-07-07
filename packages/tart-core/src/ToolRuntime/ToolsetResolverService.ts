/**
 * This file defines the ToolsetResolver service contract - per-family selection over the installed
 * Toolset (D17's `Toolset.resolve`, named ToolsetResolver because the runtime handler seam already owns
 * the `Toolset` tag). AgentRuntime resolves the active tool names for a model at each epoch boundary
 * (agent start; later, model change) and records them on `agent_started` / `tools-change` entries.
 */
import { Context } from 'effect'
import type { Effect } from 'effect'

import type { ActiveModel } from '../EventLog/Schemas'

/** Input for resolving the active toolset for one model. */
export type ResolveToolsetInput = {
	readonly model: ActiveModel
}

/** The resolved active toolset: the tool names advertised to the model for the epoch. */
export type ResolvedToolset = {
	readonly names: ReadonlyArray<string>
}

/** Per-family toolset selection over the installed tools. */
export type ToolsetResolverService = {
	readonly resolve: (input: ResolveToolsetInput) => Effect.Effect<ResolvedToolset>
}

/** ToolsetResolver service tag. Swappable wholesale by presets and hosts (D17). */
export class ToolsetResolver extends Context.Service<ToolsetResolver, ToolsetResolverService>()(
	'tart/ToolsetResolver',
) {}
