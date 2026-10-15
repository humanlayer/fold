/**
 * This file defines the HookRunner service, built from hook configuration data. It consumes EventLog
 * and Ids so it can provide every hook handler durable ToolState scoped to the current (agent, tool call);
 * the namespace of each read or write comes from the hook's own defineToolState declaration, not its name.
 * The caller of each hook point provides StopController from the surrounding run or batch.
 */
import { Context, Effect, Data, Predicate, Cause, Layer } from 'effect'

import { EventLog, type EventLogService } from '../EventLog/EventLogService'
import { Ids, type AgentId, type IdsService, type ToolCallId } from '../Ids'
import type { StopController } from '../ToolRuntime/ToolContextServices'
import { toolStateServiceForToolCall } from '../ToolRuntime/ToolStateFactory'
import { ToolState } from '../ToolRuntime/ToolStateService'
import { HookExecutionError, type HookPhase } from './Errors'
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
import type { HookScope, OnCompleteHook, PostToolUseHook, PreRequestHook, PreToolUseHook, HookConfig } from './Types'

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

type HookDecision = PreRequestHookDecision | PreToolUseHookDecision | PostToolUseHookDecision | OnCompleteHookDecision
const HookDecision = Data.taggedEnum<HookDecision>()

const isHookConfiguredForTool = (hook: { readonly tools?: ReadonlyArray<string> }, toolName: string): boolean =>
	hook.tools === undefined || hook.tools.includes(toolName)

const catchHookExecutionError = <A, R>(
	effect: Effect.Effect<A, never, R>,
	phase: HookPhase,
	hookName: string,
): Effect.Effect<A, HookExecutionError, R> =>
	effect.pipe(
		Effect.catchCauseIf(
			(cause) => !Cause.hasInterrupts(cause),
			(cause) => Effect.fail(new HookExecutionError(phase, hookName, cause)),
		),
	)

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

/** Identity of the log scope a hook invocation writes its own durable state into. */
type HookStateScope = {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId | null
}

/** Provide one hook handler its durable ToolState scoped to (agent, tool call), leaving StopController to the caller. */
const provideHookState =
	(eventLog: EventLogService, ids: IdsService) =>
	<A>(effect: Effect.Effect<A, never, HookScope>, scope: HookStateScope): Effect.Effect<A, never, StopController> =>
		Effect.gen(function* () {
			const state = yield* toolStateServiceForToolCall({
				agentId: scope.agentId,
				parentAgentId: scope.parentAgentId,
				toolCallId: scope.toolCallId,
			}).pipe(Effect.provideService(EventLog, eventLog), Effect.provideService(Ids, ids))

			return yield* effect.pipe(Effect.provideService(ToolState, state))
		})

/** HookRunner service tag. */
export class HookRunner extends Context.Service<HookRunner, HookRunnerService>()('fold/HookRunner', {
	/** Build a HookRunner from hook configuration data. */
	make: (hooks: HookConfig) =>
		Effect.gen(function* () {
			const eventLog = yield* EventLog
			const ids = yield* Ids
			const withHookState = provideHookState(eventLog, ids)

			const runPreRequestHook = (hook: PreRequestHook, input: PreRequestHookInput) =>
				catchHookExecutionError(
					withHookState(hook.handler(input), { ...input, toolCallId: null }).pipe(
						Effect.withSpan('fold.hook_runner.pre_request.hook', {
							attributes: { hookName: hook.name, ...preRequestSpanAttributes(input) },
						}),
					),
					'preRequest',
					hook.name,
				)

			const runPreToolUseHook = (hook: PreToolUseHook, input: PreToolUseHookInput) =>
				catchHookExecutionError(
					withHookState(hook.handler(input), input).pipe(
						Effect.withSpan('fold.hook_runner.pre_tool_use.hook', {
							attributes: { hookName: hook.name, ...preToolUseSpanAttributes(input) },
						}),
					),
					'preToolUse',
					hook.name,
				)

			const runPostToolUseHook = (hook: PostToolUseHook, input: PostToolUseHookInput) =>
				catchHookExecutionError(
					withHookState(hook.handler(input), input).pipe(
						Effect.withSpan('fold.hook_runner.post_tool_use.hook', {
							attributes: { hookName: hook.name, ...postToolUseSpanAttributes(input) },
						}),
					),
					'postToolUse',
					hook.name,
				)

			const runOnCompleteHook = (hook: OnCompleteHook, input: OnCompleteHookInput) =>
				catchHookExecutionError(
					withHookState(hook.handler(input), { ...input, toolCallId: null }).pipe(
						Effect.withSpan('fold.hook_runner.on_complete.hook', {
							attributes: { hookName: hook.name, ...onCompleteSpanAttributes(input) },
						}),
					),
					'onComplete',
					hook.name,
				)

			const service: HookRunnerService = {
				preRequest: (input) =>
					Effect.gen(function* () {
						let prompt = input.prompt
						let changed = false

						for (const hook of hooks.preRequest ?? []) {
							const decision = yield* runPreRequestHook(hook, { ...input, prompt })

							if (Predicate.isTagged(decision, 'changed')) {
								prompt = decision.prompt
								changed = true
							}
						}

						return changed ? HookDecision.changed({ prompt }) : HookDecision.unchanged()
					}).pipe(
						Effect.withSpan('fold.hook_runner.pre_request', {
							attributes: preRequestSpanAttributes(input),
						}),
					),

				preToolUse: (input) =>
					Effect.gen(function* () {
						let params = input.params

						for (const hook of hooks.preToolUse ?? []) {
							if (!isHookConfiguredForTool(hook, input.toolName)) continue

							const decision = yield* runPreToolUseHook(hook, { ...input, params })

							if (Predicate.isTagged(decision, 'replaceResult')) return decision

							params = decision.params
						}

						return HookDecision.continue({ params })
					}).pipe(
						Effect.withSpan('fold.hook_runner.pre_tool_use', {
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

							if (Predicate.isTagged(decision, 'replace')) {
								result = decision.result
								isFailure = decision.isFailure
								replaced = true
							}
						}

						return replaced ? HookDecision.replace({ result, isFailure }) : HookDecision.keep()
					}).pipe(
						Effect.withSpan('fold.hook_runner.post_tool_use', {
							attributes: postToolUseSpanAttributes(input),
						}),
					),

				onComplete: (input) =>
					Effect.gen(function* () {
						for (const hook of hooks.onComplete ?? []) {
							const decision = yield* runOnCompleteHook(hook, input)

							if (Predicate.isTagged(decision, 'continueWith')) return decision
						}

						return HookDecision.complete()
					}).pipe(
						Effect.withSpan('fold.hook_runner.on_complete', {
							attributes: onCompleteSpanAttributes(input),
						}),
					),
			}

			return service
		}),
}) {
	static readonly layer = (hooks: HookConfig) => Layer.effect(this, this.make(hooks))
}
