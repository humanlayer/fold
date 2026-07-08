/**
 * Engine tests for interrupting a running subagent (D10/D21): interrupting the dispatching send tears
 * the subagent's fiber down structurally; the uninterruptible exit finalizers write the durable child
 * markers (interrupt note user-message + agent-finished{interrupted}) and refine the InterruptNote, so
 * the dispatcher's synthetic tool result names the subagent id and turn count; everything the subagent
 * did before the interrupt is already durable (write-through log); and the interrupted subagent is
 * resumable over the same log and completes.
 */
import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber } from 'effect'

import { defineSubagent, type LogEntry, type UserMessageLogEntry } from '../../src/index'
import { claudeActiveModel } from '../Api/ApiTestHelpers'
import { textTurn } from '../TestLayers/ScriptedLanguageModel'
import { toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { makeDriveSession, makeHangOnceModel, renderedDriveResult, subagentStartedEntries } from './DriveHarness'

it.effect('an interrupted subagent leaves honest durable markers and is resumable', () =>
	Effect.gen(function* () {
		const hangOnce = yield* makeHangOnceModel(claudeActiveModel, [textTurn('finished after interrupt')])
		const researcher = defineSubagent({
			name: 'researcher',
			description: 'explores',
			systemPrompt: 'You are a researcher.',
			model: hangOnce.model,
		})

		// Root script: the interrupted send consumes only its tool-call turn; the second send drives the
		// resume and then finishes.
		const { session, drive, queue } = yield* makeDriveSession({
			definitions: [researcher],
			rootTurns: 0,
			rootScript: [
				toolCallTurn([{ id: 'provider-call-1', name: 'drive', params: {} }]),
				toolCallTurn([{ id: 'provider-call-2', name: 'drive', params: {} }]),
				textTurn('root done'),
			],
		})

		// Dispatch, then interrupt the send once the subagent's (hanging) model call is in flight.
		yield* queue({ op: 'dispatch', agent: 'researcher', prompt: 'long task' })
		const sendFiber = yield* Effect.forkScoped(session.send('next'))
		yield* Deferred.await(hangOnce.firstRequestStarted)
		yield* Fiber.interrupt(sendFiber)

		const entries = yield* session.entries
		const started = subagentStartedEntries(entries)[0]
		if (started === undefined) throw new Error('expected the dispatched subagent to have started')

		// Write-through: everything the subagent did before the interrupt is already durable.
		const subagentTags = entries
			.filter((entry) => 'agentId' in entry && entry.agentId === started.agentId)
			.map((entry) => entry._tag)
		expect(subagentTags).toEqual([
			'agent_started',
			'system-message',
			'user-message',
			'user-message',
			'agent-finished',
		])

		// The child-side markers: the interrupt note user-message and the interrupted terminal marker.
		const markerMessage = entries.filter(
			(entry): entry is UserMessageLogEntry => entry._tag === 'user-message' && entry.agentId === started.agentId,
		)[1]
		expect(JSON.stringify(markerMessage)).toContain('You were interrupted by the user')

		const finished = entries.findLast(
			(entry): entry is LogEntry & { readonly outcome: string } =>
				entry._tag === 'agent-finished' && entry.agentId === started.agentId,
		)
		if (finished === undefined || finished._tag !== 'agent-finished') throw new Error('expected agent-finished')
		expect(finished.outcome).toBe('interrupted')

		// The dispatcher's synthetic tool result carries the enriched InterruptNote: id + turn count.
		const rendered = renderedDriveResult(entries, 0)
		expect(rendered).toContain('The user interrupted the execution of this tool call.')
		expect(rendered).toContain(`agent_id: ${started.agentId}`)
		expect(rendered).toContain('interrupted after 0 turns')

		// Slice 2 (D10): the interrupted root run has its own durable terminal marker, written by the
		// facade's uninterruptible exit finalizer after the child's markers landed.
		const rootFinished = entries.findLast(
			(entry) => entry._tag === 'agent-finished' && entry.agentId !== started.agentId,
		)
		if (rootFinished === undefined || rootFinished._tag !== 'agent-finished') {
			throw new Error('expected the root interrupt marker')
		}
		expect(rootFinished.outcome).toBe('interrupted')

		// Resume the interrupted subagent over the same log: it sees its history and completes.
		const resumedFinished = yield* drive({ op: 'resume', agentId: started.agentId, prompt: 'pick it back up' })
		expect(resumedFinished.outcome).toBe('completed')

		const afterResume = yield* session.entries
		expect(subagentStartedEntries(afterResume)).toHaveLength(1) // still no second agent_started
		const resumedRendered = renderedDriveResult(afterResume, 1)
		expect(resumedRendered).toContain('finished after interrupt')
		expect(resumedRendered).toContain('turns: 1 this run (1 total)')

		// The resumed model call saw the pre-interrupt history including the interrupt marker.
		const prompts = yield* hangOnce.prompts
		const resumedPrompt = JSON.stringify(prompts[1])
		expect(resumedPrompt).toContain('long task')
		expect(resumedPrompt).toContain('You were interrupted by the user')
		expect(resumedPrompt).toContain('pick it back up')
	}).pipe(Effect.scoped),
)
