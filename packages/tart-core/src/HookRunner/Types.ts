import type { Effect } from 'effect'

import type { StopController } from '../ToolRuntime/ToolContextServices'
import type { ToolState } from '../ToolRuntime/ToolStateService'
import type {
	OnCompleteHookDecision,
	OnCompleteHookInput,
	PostToolUseHookDecision,
	PostToolUseHookInput,
	PreRequestHookDecision,
	PreRequestHookInput,
	PreToolUseHookDecision,
	PreToolUseHookInput,
} from './Schema.ts'

/**
 * Ambient services every hook handler may use.
 *
 * - {@link ToolState} is durable KV state accessed through explicitly declared `defineToolState`
 *   namespaces; the hook's `name` is not a namespace. The HookRunner provides the service around each
 *   invocation, scoped to the current (agent, tool call). For tool hooks the state entries carry the
 *   current toolCallId; for preRequest/onComplete hooks they carry `toolCallId: null`.
 * - {@link StopController} lets a hook request a cooperative stop and still return a normal decision;
 *   the runtime consults the flag after the current batch. It is provided by the calling runtime
 *   (ToolRuntime for tool hooks, AgentRuntime for request/completion hooks).
 */
export type HookScope = ToolState | StopController

export type PreRequestHook = {
	readonly name: string
	readonly handler: (input: PreRequestHookInput) => Effect.Effect<PreRequestHookDecision, never, HookScope>
}

export type PreToolUseHook = {
	readonly name: string
	readonly tools?: ReadonlyArray<string>
	readonly handler: (input: PreToolUseHookInput) => Effect.Effect<PreToolUseHookDecision, never, HookScope>
}

export type PostToolUseHook = {
	readonly name: string
	readonly tools?: ReadonlyArray<string>
	readonly handler: (input: PostToolUseHookInput) => Effect.Effect<PostToolUseHookDecision, never, HookScope>
}

export type OnCompleteHook = {
	readonly name: string
	readonly handler: (input: OnCompleteHookInput) => Effect.Effect<OnCompleteHookDecision, never, HookScope>
}

export type HookConfig = {
	readonly preRequest?: ReadonlyArray<PreRequestHook>
	readonly preToolUse?: ReadonlyArray<PreToolUseHook>
	readonly postToolUse?: ReadonlyArray<PostToolUseHook>
	readonly onComplete?: ReadonlyArray<OnCompleteHook>
}
