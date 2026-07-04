import { Effect, Layer } from 'effect'

import { HookRunner, type HookRunnerService } from './HookRunnerService'
import type { OnCompleteHookInput, PostToolUseHookInput, PreRequestHookInput, PreToolUseHookInput } from './Schema'
import type { OnCompleteHook, PostToolUseHook, PreRequestHook, PreToolUseHook, HookConfig } from './Types.ts'

const isHookConfiguredForTool = (hook: { readonly tools?: ReadonlyArray<string> }, toolName: string): boolean =>
	hook.tools === undefined || hook.tools.includes(toolName)

const preRequestSpanAttributes = (input: PreRequestHookInput) => ({
	agentId: input.agentId,
})

const preToolUseSpanAttributes = (input: PreToolUseHookInput) => ({
	agentId: input.agentId,
	toolCallId: input.toolCallId,
	toolName: input.toolName,
})

const postToolUseSpanAttributes = (input: PostToolUseHookInput) => ({
	agentId: input.agentId,
	toolCallId: input.toolCallId,
	toolName: input.toolName,
	isFailure: input.isFailure,
})

const onCompleteSpanAttributes = (input: OnCompleteHookInput) => ({
	agentId: input.agentId,
	hasResultText: input.resultText !== null,
})

const runPreRequestHook = (hook: PreRequestHook, input: PreRequestHookInput) =>
	hook.handler(input).pipe(
		Effect.withSpan('tart.hook_runner.pre_request.hook', {
			attributes: { hookName: hook.name, ...preRequestSpanAttributes(input) },
		}),
	)

const runPreToolUseHook = (hook: PreToolUseHook, input: PreToolUseHookInput) =>
	hook.handler(input).pipe(
		Effect.withSpan('tart.hook_runner.pre_tool_use.hook', {
			attributes: { hookName: hook.name, ...preToolUseSpanAttributes(input) },
		}),
	)

const runPostToolUseHook = (hook: PostToolUseHook, input: PostToolUseHookInput) =>
	hook.handler(input).pipe(
		Effect.withSpan('tart.hook_runner.post_tool_use.hook', {
			attributes: { hookName: hook.name, ...postToolUseSpanAttributes(input) },
		}),
	)

const runOnCompleteHook = (hook: OnCompleteHook, input: OnCompleteHookInput) =>
	hook.handler(input).pipe(
		Effect.withSpan('tart.hook_runner.on_complete.hook', {
			attributes: { hookName: hook.name, ...onCompleteSpanAttributes(input) },
		}),
	)

/** Build a HookRunner layer from hook configuration data. */
export const makeHookRunner = (hooks: HookConfig): Layer.Layer<HookRunner> => {
	const service: HookRunnerService = {
		preRequest: (input) =>
			Effect.gen(function* () {
				let prompt = input.prompt
				let changed = false

				for (const hook of hooks.preRequest ?? []) {
					const decision = yield* runPreRequestHook(hook, { ...input, prompt })

					if (decision._tag === 'changed') {
						prompt = decision.prompt
						changed = true
					}
				}

				return changed ? { _tag: 'changed' as const, prompt } : { _tag: 'unchanged' as const }
			}).pipe(
				Effect.withSpan('tart.hook_runner.pre_request', {
					attributes: preRequestSpanAttributes(input),
				}),
			),

		preToolUse: (input) =>
			Effect.gen(function* () {
				let params = input.params

				for (const hook of hooks.preToolUse ?? []) {
					if (!isHookConfiguredForTool(hook, input.toolName)) continue

					const decision = yield* runPreToolUseHook(hook, { ...input, params })

					if (decision._tag === 'replaceResult') return decision

					params = decision.params
				}

				return { _tag: 'continue' as const, params }
			}).pipe(
				Effect.withSpan('tart.hook_runner.pre_tool_use', {
					attributes: preToolUseSpanAttributes(input),
				}),
			),

		postToolUse: (input) =>
			Effect.gen(function* () {
				let result = input.result
				let isFailure = input.isFailure
				let replaced = false

				for (const hook of hooks.postToolUse ?? []) {
					if (!isHookConfiguredForTool(hook, input.toolName)) continue

					const decision = yield* runPostToolUseHook(hook, { ...input, result, isFailure })

					if (decision._tag === 'replace') {
						result = decision.result
						isFailure = decision.isFailure
						replaced = true
					}
				}

				return replaced ? { _tag: 'replace' as const, result, isFailure } : { _tag: 'keep' as const }
			}).pipe(
				Effect.withSpan('tart.hook_runner.post_tool_use', {
					attributes: postToolUseSpanAttributes(input),
				}),
			),

		onComplete: (input) =>
			Effect.gen(function* () {
				for (const hook of hooks.onComplete ?? []) {
					const decision = yield* runOnCompleteHook(hook, input)

					if (decision._tag === 'continueWith') return decision
				}

				return { _tag: 'complete' as const }
			}).pipe(
				Effect.withSpan('tart.hook_runner.on_complete', {
					attributes: onCompleteSpanAttributes(input),
				}),
			),
	}

	return Layer.succeed(HookRunner, service)
}
