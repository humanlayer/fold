import { Effect, Context } from "effect"
import { PreRequestHookDecision, PreRequestHookInput, PreToolUseHookDecision, PreToolUseHookInput, PostToolUseHookDecision, PostToolUseHookInput, OnCompleteHookDecision, OnCompleteHookInput } from './Schema'

/**
 * important - these are not allowed to fail - the provided / caller must handle failues internally e.g. by falling back to the default action.
 */
export type HookRunnerService = {
	/** execute pre-request hooks. not allowed to fail - hooks must handle internally by using a default action in the event of failures */
	readonly preRequest: (input: PreRequestHookInput) => Effect.Effect<PreRequestHookDecision>
	/** execute pre-tool-use hooks. not allowed to fail - hooks must handle internally by using a default action in the event of failures */
	readonly preToolUse: (input: PreToolUseHookInput) => Effect.Effect<PreToolUseHookDecision>
	/** execute post-tool-use hooks. not allowed to fail - hooks must handle internally by using a default action in the event of failures */
	readonly postToolUse: (input: PostToolUseHookInput) => Effect.Effect<PostToolUseHookDecision>
	/** execute on-complete hooks when the model stops gracefully. not allowed to fail - hooks must handle internally by using a default action in the event of failures */
	readonly onComplete: (input: OnCompleteHookInput) => Effect.Effect<OnCompleteHookDecision>
}

export class HookRunner extends Context.Service<HookRunner, HookRunnerService>()('tart/HookRunner'){}