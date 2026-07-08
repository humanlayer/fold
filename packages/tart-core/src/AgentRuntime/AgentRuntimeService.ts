/**
 * This file defines the AgentRuntime service contract - the model loop for one agent. Session-level
 * code consumes this service to start an agent and run it to its next terminal marker, while the live
 * implementation consumes EventLog, Ids, HookRunner, Toolset, ToolRuntime, and LanguageModel to loop
 * model turns and tool settlements until the agent finishes.
 */
import { Context } from 'effect'
import type { Array as Arr, Effect } from 'effect'

import type {
	ActiveModel,
	AgentFinishedLogEntry,
	AgentFork,
	AgentLaunchMode,
	AgentStartedLogEntry,
} from '../EventLog/Schemas'
import type { AgentId, ToolCallId } from '../Ids'

/** Input for starting one agent. parentAgentId and toolCallId are null for root agents. */
export type StartAgentInput = {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId | null
	/** Fresh context window, or a by-reference fork of another agent's history (D2/D21). */
	readonly mode: AgentLaunchMode
	/** Fork provenance; required exactly when mode is "fork". Forks append no leading system message. */
	readonly fork: AgentFork | null
	/** Skill preloaded at dispatch (D21); recorded on agent_started, injected as a user message by the caller. */
	readonly skill: string | null
	/** Registry type name the agent was dispatched as (D21); null for the root agent and forks. */
	readonly agentType: string | null
	readonly model: ActiveModel
	/** One leading system block, an ordered set of blocks (one system message each), or null for none. */
	readonly systemPrompt: string | ReadonlyArray<string> | null
}

/** Input for running one started agent through a full user-message-to-finished run. */
export type RunAgentInput = {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId | null
	/**
	 * Initial user messages for this run, appended in order before the first model turn. Multiple
	 * messages carry a dispatch prompt followed by injected context such as a preloaded skill (D21).
	 */
	readonly messages: Arr.NonEmptyReadonlyArray<string>
}

/** Input for switching one started agent to a different model (a new epoch - D17). */
export type SwitchModelInput = {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId | null
	readonly model: ActiveModel
	/** The agent's own prompt blocks, recomposed with the new family's base prompt. */
	readonly systemPrompt: string | ReadonlyArray<string> | null
	readonly reason: string | null
}

/**
 * Agent lifecycle operations.
 *
 * `run` means: append the user message, loop model and tool turns, and resolve with the durable
 * `agent-finished` entry. Model provider failures are durable facts (`error` + `agent-finished`
 * with outcome `error`), not service failures, so a resolved run always has a terminal log marker.
 *
 * `switchModel` writes the D17 epoch-transition choreography: `model-change`, the recomposed leading
 * `system-message` block set for the new model's family, and `tools-change` with the newly resolved
 * toolset. The next `run` binds all three. Callers still provide/swap the LanguageModel layer for the
 * new provider (AgentModels will own that - D15).
 */
export type AgentRuntimeService = {
	readonly start: (input: StartAgentInput) => Effect.Effect<AgentStartedLogEntry>
	readonly run: (input: RunAgentInput) => Effect.Effect<AgentFinishedLogEntry>
	readonly switchModel: (input: SwitchModelInput) => Effect.Effect<void>
}

/** AgentRuntime service tag. */
export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeService>()('tart/AgentRuntime') {}
