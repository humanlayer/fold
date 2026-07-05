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
