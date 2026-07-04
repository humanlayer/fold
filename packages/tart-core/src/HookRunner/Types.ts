import type { Effect } from 'effect'

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

export type PreRequestHook = {
	readonly name: string
	readonly handler: (input: PreRequestHookInput) => Effect.Effect<PreRequestHookDecision>
}

export type PreToolUseHook = {
	readonly name: string
	readonly tools?: ReadonlyArray<string>
	readonly handler: (input: PreToolUseHookInput) => Effect.Effect<PreToolUseHookDecision>
}

export type PostToolUseHook = {
	readonly name: string
	readonly tools?: ReadonlyArray<string>
	readonly handler: (input: PostToolUseHookInput) => Effect.Effect<PostToolUseHookDecision>
}

export type OnCompleteHook = {
	readonly name: string
	readonly handler: (input: OnCompleteHookInput) => Effect.Effect<OnCompleteHookDecision>
}

export type HookConfig = {
	readonly preRequest?: ReadonlyArray<PreRequestHook>
	readonly preToolUse?: ReadonlyArray<PreToolUseHook>
	readonly postToolUse?: ReadonlyArray<PostToolUseHook>
	readonly onComplete?: ReadonlyArray<OnCompleteHook>
}
