import { Data, type Cause } from 'effect'

export type HookPhase = 'preRequest' | 'preToolUse' | 'postToolUse' | 'onComplete'

export class HookExecutionError extends Data.TaggedError('HookExecutionError')<{
	readonly phase: HookPhase
	readonly hookName: string
	readonly cause: Cause.Cause<never>
}> {
	constructor(phase: HookPhase, hookName: string, cause: Cause.Cause<never>) {
		super({ phase, hookName, cause })
	}

	override get message(): string {
		return `${this.phase} hook "${this.hookName}" failed`
	}
}
