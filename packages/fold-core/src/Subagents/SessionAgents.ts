/**
 * This file defines SessionAgents - how one session builds its agents: the flat registry of
 * dispatchable types, the tool contributions every agent's tools are realized against, the root
 * agent's current configuration, and the session-wide auto-compaction policy. `Session.open` provides
 * it with the other session services; agent provisioning and the subagent operations read it.
 */
import { Context } from 'effect'
import type { Effect } from 'effect'

import type { FoldModel } from '../Api/ModelDescriptor'
import type { FoldTool, RealizedFoldTool } from '../Api/ToolDefinition'
import type { AutoCompactConfig } from '../Compaction/CompactionService'
import type { HookConfig } from '../HookRunner/Types'
import type { SkillSourceService } from '../Skills/SkillSource'
import type { AgentRegistry } from './AgentRegistry'

/** One agent's tools realized against the session-start contributions (once-per-value inits). */
export type RealizedAgentTools = {
	readonly tools: ReadonlyArray<RealizedFoldTool>
	/** Prompt blocks contributed by session-initialized tools, in tools-array order. */
	readonly promptBlocks: ReadonlyArray<string>
	/** The skill source contributed by this agent's skillTool, for dispatch-time skill preload. */
	readonly skillSource: SkillSourceService | null
}

/** The root agent's current configuration; model switches move it (read fresh per dispatch). */
export type RootAgentSnapshot = {
	readonly model: FoldModel<unknown>
	readonly promptCacheKey: string | null
	/** The root's tools as configured (system-tool values included). */
	readonly tools: ReadonlyArray<FoldTool<unknown>>
	readonly hooks: HookConfig
	/** The root's own leading blocks, WITHOUT tool-contributed blocks (those come from realization). */
	readonly systemPrompt: ReadonlyArray<string>
}

export type SessionAgentsService = {
	readonly registry: AgentRegistry
	/** Realize one agent's configured tools via the session-start contribution map (§2.5). */
	readonly realizeTools: (tools: ReadonlyArray<FoldTool<unknown>>) => RealizedAgentTools
	readonly currentRoot: Effect.Effect<RootAgentSnapshot>
	/** Shared by every provisioned runtime - root and subagent - checking its own projection (D11). */
	readonly autoCompact: AutoCompactConfig | undefined
}

export class SessionAgents extends Context.Service<SessionAgents, SessionAgentsService>()('fold/SessionAgents') {}
