import { Effect } from 'effect'
import { expect, it } from 'vitest'

import {
	executeRootInputAction,
	isEnterKey,
	isSubmitShortcut,
	nextRootInputVerb,
	normalizeRootInputVerb,
	rootInputVerbLabel,
	rootInputVerbs,
} from '../src/tui/Converse'

it('resolves root input verbs from the target state', () => {
	expect(rootInputVerbs('IDLE')).toEqual(['send'])
	expect(rootInputVerbs('STOPPED')).toEqual(['send'])
	expect(rootInputVerbs('RUNNING')).toEqual(['steer', 'interrupt-send'])
	expect(normalizeRootInputVerb('RUNNING', 'send')).toBe('steer')
	expect(normalizeRootInputVerb('IDLE', 'interrupt-send')).toBe('send')
})

it('cycles only the verbs valid for a running target', () => {
	expect(nextRootInputVerb('RUNNING', 'steer')).toBe('interrupt-send')
	expect(nextRootInputVerb('RUNNING', 'interrupt-send')).toBe('steer')
	expect(nextRootInputVerb('IDLE', 'send')).toBe('send')
	expect(rootInputVerbLabel('interrupt-send')).toBe('INTERRUPT+SEND')
})

it('requires a command/meta modified enter to submit', () => {
	expect(isSubmitShortcut({ name: 'enter', meta: true, super: false })).toBe(true)
	expect(isSubmitShortcut({ name: 'return', meta: false, super: true })).toBe(true)
	expect(isSubmitShortcut({ name: 'enter', meta: false, super: true })).toBe(true)
	expect(isSubmitShortcut({ name: 'enter', meta: false, super: false })).toBe(false)
	expect(isSubmitShortcut({ name: 'q', meta: true, super: false })).toBe(false)
	expect(isEnterKey('return')).toBe(true)
})

it('runs interrupt before sending the replacement message', async () => {
	const calls: Array<string> = []
	const notices: Array<string> = []

	await Effect.runPromise(
		executeRootInputAction(
			{
				send: (text) => Effect.sync(() => calls.push(`send:${text}`)),
				steer: (text) => Effect.sync(() => calls.push(`steer:${text}`)).pipe(Effect.asVoid),
				interrupt: () => Effect.sync(() => calls.push('interrupt')).pipe(Effect.asVoid),
			},
			'interrupt-send',
			'replacement',
			(notice) => notices.push(notice),
		),
	)

	expect(calls).toEqual(['interrupt', 'send:replacement'])
	expect(notices).toEqual([])
})

it('surfaces an unexpected action defect as a UI notice', async () => {
	const notices: Array<string> = []

	await Effect.runPromise(
		executeRootInputAction(
			{
				send: () => Effect.die(new Error('send exploded')),
				steer: () => Effect.void,
				interrupt: () => Effect.void,
			},
			'send',
			'hello',
			(notice) => notices.push(notice),
		),
	)

	expect(notices).toHaveLength(1)
	expect(notices[0]).toContain('ERROR · UNEXPECTED ACTION FAILURE · Error: send exploded')
})
