/**
 * This file defines the ToolRuntime service contract for settling tool calls from one assistant message.
 * AgentRuntime consumes this service after a model response is persisted, while the live implementation
 * consumes EventLog, Ids, HookRunner, Toolset, and ToolEventSink to run hooks, execute handlers, persist
 * tool results, expose ToolState, and report progress.
 */
import { Context } from 'effect'
import type { Effect } from 'effect'
import type { Prompt } from 'effect/unstable/ai'

import type { ToolResultLogEntry } from '../EventLog/Schemas.ts'
import type { AgentId } from '../Ids.ts'

/** Result of settling all tool calls from one persisted assistant message. */
export type ToolSettlement = {
	readonly toolResults: ReadonlyArray<ToolResultLogEntry>
	readonly stopRequested: boolean
}

/** Deep service surface for hook-aware tool settlement. */
export type ToolRuntimeService = {
	/** Execute or replace every tool call in one assistant message and persist exactly one result per call. */
	readonly settle: (input: {
		readonly agentId: AgentId
		readonly parentAgentId: AgentId | null
		readonly assistantMessage: Prompt.AssistantMessage
	}) => Effect.Effect<ToolSettlement>
}

/** ToolRuntime service tag. */
export class ToolRuntime extends Context.Service<ToolRuntime, ToolRuntimeService>()('fold/ToolRuntime') {}
