import { Context } from 'effect'
import type { Effect } from 'effect'

import type { StopController } from '../ToolRuntime/ToolContextServices'
import type { HookExecutionError } from './Errors'
import type {
	OnCompleteHookDecision,
	OnCompleteHookInput,
	PostToolUseHookDecision,
	PostToolUseHookInput,
	PreRequestHookDecision,
	PreRequestHookInput,
	PreToolUseHookDecision,
	PreToolUseHookInput,
} from './Schema'

/**
 * Runtime interpreter for hook configuration data.
 *
 * Hook chains are not allowed to fail - authors resolve failures at authorship time (e.g. by falling
 * back to the default decision). The runner provides each hook its own namespace-scoped ToolState;
 * the caller provides {@link StopController} from the scope of the current run or tool batch so any
 * hook may request a cooperative stop while still returning a normal decision.
 */
export type HookRunnerService = {
	readonly preRequest: (
		input: PreRequestHookInput,
	) => Effect.Effect<PreRequestHookDecision, HookExecutionError, StopController>
	readonly preToolUse: (
		input: PreToolUseHookInput,
	) => Effect.Effect<PreToolUseHookDecision, HookExecutionError, StopController>
	readonly postToolUse: (
		input: PostToolUseHookInput,
	) => Effect.Effect<PostToolUseHookDecision, HookExecutionError, StopController>
	readonly onComplete: (
		input: OnCompleteHookInput,
	) => Effect.Effect<OnCompleteHookDecision, HookExecutionError, StopController>
}

export class HookRunner extends Context.Service<HookRunner, HookRunnerService>()('fold/HookRunner') {}
