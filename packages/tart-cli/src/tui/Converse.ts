import type { AgentNotRunningError, SubagentNotFoundError } from '@humanlayer/tart-core'
import { Cause, Effect } from 'effect'

import type { SessionState } from './SessionState'

export const ROOT_INPUT_VERBS = ['send', 'steer', 'interrupt-send'] as const
export type RootInputVerb = (typeof ROOT_INPUT_VERBS)[number]

export const rootInputVerbs = (
	status: SessionState['status'],
): readonly [RootInputVerb, ...ReadonlyArray<RootInputVerb>] =>
	status === 'RUNNING' ? ['steer', 'interrupt-send'] : ['send']

export const normalizeRootInputVerb = (status: SessionState['status'], verb: RootInputVerb): RootInputVerb => {
	const valid = rootInputVerbs(status)
	return valid.includes(verb) ? verb : valid[0]
}

export const nextRootInputVerb = (status: SessionState['status'], verb: RootInputVerb): RootInputVerb => {
	const valid = rootInputVerbs(status)
	const current = valid.indexOf(normalizeRootInputVerb(status, verb))
	return valid[(current + 1) % valid.length] ?? valid[0]
}

export const rootInputVerbLabel = (verb: RootInputVerb): string =>
	verb === 'interrupt-send' ? 'INTERRUPT+SEND' : verb.toUpperCase()

export const isEnterKey = (name: string): boolean => name === 'enter' || name === 'return'

export type RootInputActionTarget = {
	readonly send: (text: string) => Effect.Effect<unknown, SubagentNotFoundError>
	readonly steer: (text: string) => Effect.Effect<void, AgentNotRunningError>
	readonly interrupt: () => Effect.Effect<void>
}

const causeSummary = (cause: Cause.Cause<unknown>): string => {
	const firstLine = Cause.pretty(cause)
		.split(/\r?\n/)
		.find((line) => line.trim().length > 0)
	return firstLine?.trim() ?? 'unknown cause'
}

export const unexpectedActionCauseNotice = (cause: Cause.Cause<unknown>): string =>
	`ERROR · UNEXPECTED ACTION FAILURE · ${causeSummary(cause)}`

export const executeRootInputAction = (
	target: RootInputActionTarget,
	verb: RootInputVerb,
	text: string,
	onNotice: (notice: string) => void,
): Effect.Effect<void> => {
	const notify = (notice: string) => Effect.sync(() => onNotice(notice))
	const action: Effect.Effect<void, SubagentNotFoundError> = (() => {
		switch (verb) {
			case 'send':
				return target.send(text).pipe(Effect.asVoid)
			case 'steer':
				return target
					.steer(text)
					.pipe(Effect.catchTag('AgentNotRunningError', () => target.send(text).pipe(Effect.asVoid)))
			case 'interrupt-send':
				return target.interrupt().pipe(Effect.andThen(target.send(text)), Effect.asVoid)
		}
	})()

	return action.pipe(
		Effect.catchTag('SubagentNotFoundError', (error) => notify(`ERROR · ${error.message}`)),
		Effect.catchCause((cause) => notify(unexpectedActionCauseNotice(cause))),
	)
}
