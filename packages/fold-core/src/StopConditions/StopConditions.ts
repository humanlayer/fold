/**
 * Runtime stop-condition policy for agent loops. Core owns the loop boundary and the durable stopped
 * outcome; hosts own which policies are enabled. The first policy is a doom-loop detector: if an agent
 * emits the same tool-call batch repeatedly, fold lets the current batch settle, then stops gracefully
 * before another model request.
 */
import { Array as Arr, Context, Equal } from 'effect'
import type { Prompt } from 'effect/ai'

/** Doom-loop detector configuration. Omitted means disabled. */
export type DoomLoopStopCondition =
	| { readonly enabled: false }
	| {
			readonly enabled: true
			/** Number of consecutive identical tool-call batches that triggers a graceful stop. */
			readonly repeatedToolCalls: number
	  }

/** Stop-condition policy installed for one session. */
export type StopConditionConfig = {
	readonly doomLoop?: DoomLoopStopCondition
}

/** A model-visible tool call, projected to only the fields relevant for doom-loop detection. */
export type ToolCallFingerprintInput = {
	readonly name: string
	readonly params: Prompt.ToolCallPart['params']
}

/** Per-run doom-loop detector state: the last observed batch and how many times it repeated in a row. */
export type DoomLoopState = {
	readonly batch: ReadonlyArray<ToolCallFingerprintInput> | null
	readonly count: number
}

/** Result of observing a tool-call batch against the stop-condition policy. */
export type DoomLoopObservation = {
	readonly state: DoomLoopState
	readonly reason: string | null
}

/** Empty per-run detector state. */
export const initialDoomLoopState: DoomLoopState = { batch: null, count: 0 }

/** Observe one tool-call batch and decide whether the configured doom-loop policy should stop the run. */
export const observeDoomLoop = (
	config: StopConditionConfig,
	state: DoomLoopState,
	toolCalls: ReadonlyArray<ToolCallFingerprintInput>,
): DoomLoopObservation => {
	if (config.doomLoop === undefined || !config.doomLoop.enabled || Arr.isReadonlyArrayEmpty(toolCalls)) {
		return { state: initialDoomLoopState, reason: null }
	}

	// Effect's structural equality ignores object key order, so reordered params still repeat.
	const count = Equal.equals(state.batch, toolCalls) ? state.count + 1 : 1
	const nextState = { batch: toolCalls, count }
	const threshold = config.doomLoop.repeatedToolCalls

	return count >= threshold
		? {
				state: nextState,
				reason: `doom loop detected: repeated the same tool-call batch ${count} times`,
			}
		: { state: nextState, reason: null }
}

/** Session-wide stop-condition policy consumed by AgentRuntime. Default disabled for low-level hosts. */
export const StopConditions: Context.Reference<StopConditionConfig> = Context.Reference('fold/StopConditions', {
	defaultValue: () => ({}),
})
