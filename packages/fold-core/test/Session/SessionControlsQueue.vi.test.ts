/**
 * SessionControls queue semantics for runtime-written messages: queued messages keep their origin, and
 * adjacent task notifications drain as one message (one-at-a-time steering counts the run as one unit).
 */
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { AgentId, coalesceQueuedMessages, layerSessionControls, SessionControls } from '../../src/index'

const first = AgentId.create()
const second = AgentId.create()
const notification = (taskId: AgentId, text: string) => ({
	text,
	origin: { _tag: 'task-notification' as const, taskIds: [taskId] },
})

it('coalesces adjacent task notifications and keeps other messages in order', () => {
	const merged = coalesceQueuedMessages([
		{ text: 'plain', origin: null },
		notification(first, 'one'),
		notification(second, 'two'),
		{ text: 'after', origin: null },
	])

	expect(merged).toEqual([
		{ text: 'plain', origin: null },
		{ text: 'one\n\ntwo', origin: { _tag: 'task-notification', taskIds: [first, second] } },
		{ text: 'after', origin: null },
	])
})

it.effect('one-at-a-time steering drains a run of notifications as one message', () =>
	Effect.gen(function* () {
		const controls = yield* SessionControls
		const agent = AgentId.create()
		yield* controls.claimRunning(agent)
		yield* controls.steer(agent, 'one', { _tag: 'task-notification', taskIds: [first] })
		yield* controls.steer(agent, 'two', { _tag: 'task-notification', taskIds: [second] })
		yield* controls.steer(agent, 'person')

		expect(yield* controls.drainSteering(agent)).toEqual([
			{ text: 'one\n\ntwo', origin: { _tag: 'task-notification', taskIds: [first, second] } },
		])
		expect(yield* controls.drainSteering(agent)).toEqual([{ text: 'person', origin: null }])
		expect(yield* controls.runningAgentIds).toEqual([agent])
	}).pipe(Effect.provide(layerSessionControls())),
)
