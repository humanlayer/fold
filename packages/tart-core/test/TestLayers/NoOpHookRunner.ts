import { Effect, Layer } from 'effect'

import { HookRunner, type HookRunnerService } from '../../src/HookRunner/HookRunnerService'
import type {
	OnCompleteHookInput,
	PostToolUseHookInput,
	PreRequestHookInput,
	PreToolUseHookInput,
} from '../../src/HookRunner/Schema'

/**
 * Hook Runner test layer that no-ops for each - i.e. no change.
 * Safe for runtime if no hooks are provided
 */
const noopHooks: HookRunnerService = {
	preRequest: Effect.fn('tart.hook_runner.pre_request.noop')((_input: PreRequestHookInput) =>
		Effect.succeed({ _tag: 'unchanged' as const }),
	),

	preToolUse: Effect.fn('tart.hook_runner.pre_tool_use.noop')((input: PreToolUseHookInput) =>
		Effect.succeed({
			_tag: 'continue' as const,
			params: input.params,
		}),
	),

	postToolUse: Effect.fn('tart.hook_runner.post_tool_use.noop')((_input: PostToolUseHookInput) =>
		Effect.succeed({ _tag: 'keep' as const }),
	),

	onComplete: Effect.fn('tart.hook_runner.on_complete.noop')((_input: OnCompleteHookInput) =>
		Effect.succeed({ _tag: 'complete' as const }),
	),
}

export const hookRunnerNoop = Layer.succeed(HookRunner, noopHooks)
