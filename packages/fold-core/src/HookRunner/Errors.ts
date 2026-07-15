import type { Cause } from 'effect'

export type HookPhase = 'preRequest' | 'preToolUse' | 'postToolUse' | 'onComplete'

export class HookExecutionError extends Error {
	readonly _tag = 'HookExecutionError'

	constructor(
		readonly phase: HookPhase,
		readonly hookName: string,
		override readonly cause: Cause.Cause<never>,
	) {
		super(`${phase} hook "${hookName}" failed`)
	}
}
