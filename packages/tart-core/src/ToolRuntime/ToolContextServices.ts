/**
 * This file defines the ambient services available inside a running tool handler. ToolRuntime produces
 * per-call ToolEvents and StopController services, tool handlers consume them for progress and cooperative
 * stopping, and session-level code provides ToolEventSink to receive annotated progress events.
 */
import { Context, Effect, Schema } from 'effect'

import type { AgentId, ToolCallId } from '../Ids.ts'

/** UI/progress event emitted by a running tool. This is not the durable final tool result. */
export type ToolRuntimeEvent = {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId
	readonly toolName: string
	readonly payload: typeof Schema.Json.Type
}

/** Session-level sink for ephemeral tool progress. ToolRuntime annotates events with runtime identity. */
export type ToolEventSinkService = {
	/** Publish one already annotated tool progress event to the owning session. */
	readonly emit: (event: ToolRuntimeEvent) => Effect.Effect<void>
}

/** Sink used by ToolRuntime to publish UI/progress events. */
export class ToolEventSink extends Context.Service<ToolEventSink, ToolEventSinkService>()('tart/ToolEventSink') {}

/** No-op event sink for tests that do not assert tool progress. */
export const noopToolEventSink: ToolEventSinkService = {
	/** Ignore one emitted progress event. */
	emit: () => Effect.void,
}

/** Ambient service visible to tool handlers. Tools emit arbitrary JSON progress here. */
export type ToolEventsService = {
	/** Publish one JSON progress payload from the currently running tool call. */
	readonly emit: (payload: typeof Schema.Json.Type) => Effect.Effect<void>
}

/** Per-call tool progress emitter. ToolRuntime provides this around each handler. */
export class ToolEvents extends Context.Service<ToolEvents, ToolEventsService>()('tart/ToolEvents') {}

/** Cooperative graceful-stop controller for tools and hooks. */
export type StopControllerService = {
	/** Ask the current agent turn to stop after in-flight work reaches a safe boundary. */
	readonly requestStop: (reason: string) => Effect.Effect<void>
	/** Report whether a tool or hook has already requested a cooperative stop. */
	readonly isStopRequested: Effect.Effect<boolean>
}

/**
 * Ambient stop controller. Intentionally provided by the caller's scope (a tool settlement batch or an
 * agent run) and passed through service methods such as HookRunner's hook points, so any hook or tool
 * handler can request a cooperative stop.
 *
 * @effect-leakable-service
 */
export class StopController extends Context.Service<StopController, StopControllerService>()('tart/StopController') {}

/** The identity of the agent whose tool call is currently executing (D12). */
export type CurrentAgentService = {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
}

/** Ambient per-call agent identity. ToolRuntime provides this around each handler. */
export class CurrentAgent extends Context.Service<CurrentAgent, CurrentAgentService>()('tart/CurrentAgent') {}

/** The identity of the tool call currently executing (D12). */
export type CurrentToolCallService = {
	readonly toolCallId: ToolCallId
}

/** Ambient per-call tool-call identity. ToolRuntime provides this around each handler. */
export class CurrentToolCall extends Context.Service<CurrentToolCall, CurrentToolCallService>()(
	'tart/CurrentToolCall',
) {}

/**
 * Per-call note included in the synthetic tool result ToolRuntime writes when this tool call is
 * interrupted. Handlers doing resumable or externally-visible work set it as soon as the fact exists
 * (the subagent tool records the dispatched agent id and resume guidance; bash records the spill-file
 * path holding partial output). Last write wins; unset means the generic interruption text stands.
 */
export type InterruptNoteService = {
	/** Record the note to append inside the interrupted tool call's synthetic result. */
	readonly set: (note: string) => Effect.Effect<void>
}

/** Ambient per-call interrupt note. ToolRuntime provides this around each handler. */
export class InterruptNote extends Context.Service<InterruptNote, InterruptNoteService>()('tart/InterruptNote') {}
