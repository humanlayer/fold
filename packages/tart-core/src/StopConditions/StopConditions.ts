/**
 * Runtime stop-condition policy for agent loops. Core owns the loop boundary and the durable stopped
 * outcome; hosts own which policies are enabled. The first policy is a doom-loop detector: if an agent
 * emits the same tool-call batch repeatedly, tart lets the current batch settle, then stops gracefully
 * before another model request.
 */
import { Context } from 'effect'

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

/** Per-run doom-loop detector state. */
export type DoomLoopState = {
	readonly fingerprint: string | null
	readonly count: number
}

/** A model-visible tool call, projected to only the fields relevant for doom-loop detection. */
export type ToolCallFingerprintInput = {
	readonly name: string
	readonly params: unknown
}

/** Result of observing a tool-call batch against the stop-condition policy. */
export type DoomLoopObservation = {
	readonly state: DoomLoopState
	readonly reason: string | null
}

/** Empty per-run detector state. */
export const initialDoomLoopState: DoomLoopState = { fingerprint: null, count: 0 }

const normalizeForFingerprint = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(normalizeForFingerprint)
	if (typeof value !== 'object' || value === null) return value

	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, normalizeForFingerprint(child)]),
	)
}

const safeStableStringify = (value: unknown): string => {
	try {
		return JSON.stringify(normalizeForFingerprint(value)) ?? String(value)
	} catch {
		return String(value)
	}
}

const batchFingerprint = (toolCalls: ReadonlyArray<ToolCallFingerprintInput>): string =>
	toolCalls.map((call) => `${call.name}:${safeStableStringify(call.params)}`).join('\n')

/** Observe one tool-call batch and decide whether the configured doom-loop policy should stop the run. */
export const observeDoomLoop = (
	config: StopConditionConfig,
	state: DoomLoopState,
	toolCalls: ReadonlyArray<ToolCallFingerprintInput>,
): DoomLoopObservation => {
	if (config.doomLoop === undefined || !config.doomLoop.enabled || toolCalls.length === 0) {
		return { state: initialDoomLoopState, reason: null }
	}

	const fingerprint = batchFingerprint(toolCalls)
	const count = state.fingerprint === fingerprint ? state.count + 1 : 1
	const nextState = { fingerprint, count }
	const threshold = config.doomLoop.repeatedToolCalls

	return count >= threshold
		? {
				state: nextState,
				reason: `doom loop detected: repeated the same tool-call batch ${count} times`,
			}
		: { state: nextState, reason: null }
}

/** Session-wide stop-condition policy consumed by AgentRuntime. Default disabled for low-level hosts. */
export const StopConditions: Context.Reference<StopConditionConfig> = Context.Reference('tart/StopConditions', {
	defaultValue: () => ({}),
})
