import { Effect, Context } from 'effect'

import {
	PreRequestHookDecision,
	PreRequestHookInput,
	PreToolUseHookDecision,
	PreToolUseHookInput,
	PostToolUseHookDecision,
	PostToolUseHookInput,
	OnCompleteHookDecision,
	OnCompleteHookInput,
} from './Schema'

/**
 * important - these are not allowed to fail - the provided / caller must handle failues internally e.g. by falling back to the default action.
 */
export type HookRunnerService = {
	readonly preRequest: (input: PreRequestHookInput) => Effect.Effect<PreRequestHookDecision>
	readonly preToolUse: (input: PreToolUseHookInput) => Effect.Effect<PreToolUseHookDecision>
	readonly postToolUse: (input: PostToolUseHookInput) => Effect.Effect<PostToolUseHookDecision>
	readonly onComplete: (input: OnCompleteHookInput) => Effect.Effect<OnCompleteHookDecision>
}

export class HookRunner extends Context.Service<HookRunner, HookRunnerService>()('tart/HookRunner') {}
