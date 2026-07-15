/**
 * Slice-2 hard-interrupt tests (D10): `interrupt` cancels the live fiber tree; uninterruptible
 * finalizers keep the log honest - the mid-stream partial assistant text flushes as a durable
 * assistant-message, the root gets its terminal `agent-finished{interrupted}` marker, and the awaiting
 * send resolves with that honest outcome. A TARGETED interrupt of one running subagent folds into its
 * dispatcher's tool result as an interrupted-outcome result while the dispatcher keeps running.
 */
import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber } from 'effect'

import {
	defineAgent,
	defineSubagent,
	shortAgentId,
	startSession,
	subagentTool,
	type AssistantMessageLogEntry,
} from '../../src/index'
import { makeHangOnceModel } from '../Subagents/DriveHarness'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { claudeActiveModel, gptActiveModel, scriptedModel } from './ApiTestHelpers'
import { makePartialHangModel } from './SessionControlHarness'

it.effect('interrupt flushes partial assistant text, writes the root marker, and resumes coherently', () =>
	Effect.gen(function* () {
		const partialHang = yield* makePartialHangModel(gptActiveModel, 'I was thinking about the answer', [
			textTurn('resumed cleanly'),
		])

		const session = yield* startSession({ agent: defineAgent({ model: partialHang.model }) })

		const sendFiber = yield* Effect.forkScoped(session.send('go'))
		yield* partialHang.firstRequestStreaming
		yield* session.interrupt()

		// The awaiting send resolves with the honest interrupted outcome, not an error.
		const finished = yield* Fiber.join(sendFiber)
		expect(finished.outcome).toBe('interrupted')

		const entries = yield* session.entries

		// D10: the partial assistant text streamed before the interruption is a durable entry...
		const flushed = entries.find(
			(entry): entry is AssistantMessageLogEntry =>
				entry._tag === 'assistant-message' && JSON.stringify(entry).includes('I was thinking about the answer'),
		)
		if (flushed === undefined) throw new Error('expected the flushed partial assistant-message')
		expect(flushed.finish).toBeNull()

		// ...followed by the root's terminal marker.
		const rootFinished = entries.findLast((entry) => entry._tag === 'agent-finished')
		if (rootFinished === undefined || rootFinished._tag !== 'agent-finished') {
			throw new Error('expected the root terminal marker')
		}
		expect(rootFinished.outcome).toBe('interrupted')
		expect(entries.indexOf(rootFinished)).toBeGreaterThan(entries.indexOf(flushed))

		// Resume over the same log: the next send completes and its request carries the partial text.
		const resumed = yield* session.send('pick it back up')
		expect(resumed.outcome).toBe('completed')
		expect(resumed.resultText).toBe('resumed cleanly')

		const prompts = yield* partialHang.prompts
		const resumedPrompt = JSON.stringify(prompts[1])
		expect(resumedPrompt).toContain('I was thinking about the answer')
		expect(resumedPrompt).toContain('pick it back up')
	}).pipe(Effect.scoped),
)

it.effect('a targeted subagent interrupt folds into the dispatcher, which keeps running', () =>
	Effect.gen(function* () {
		const hangOnce = yield* makeHangOnceModel(claudeActiveModel, [])
		const researcher = defineSubagent({
			name: 'researcher',
			description: 'explores',
			model: hangOnce.model,
		})

		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([
				{
					id: 'provider-call-1',
					name: 'subagent',
					params: { description: 'explore', prompt: 'long exploration', agent: 'researcher' },
				},
			]),
			textTurn('root synthesized after the interruption'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model: rootScripted.model, tools: [subagentTool([researcher])] }),
		})

		const sendFiber = yield* Effect.forkScoped(session.send('go'))
		yield* Deferred.await(hangOnce.firstRequestStarted)

		const midRun = yield* session.entries
		const childStarted = midRun.find((entry) => entry._tag === 'agent_started' && entry.parentAgentId !== null)
		if (childStarted === undefined || childStarted._tag !== 'agent_started') {
			throw new Error('expected the dispatched subagent to have started')
		}

		yield* session.interrupt({ agentId: childStarted.agentId })

		// The ROOT keeps running: the dispatch call resolves with an interrupted-outcome RESULT (a
		// normal durable tool result, not the synthetic interrupted-call marker) and the root completes.
		const finished = yield* Fiber.join(sendFiber)
		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('root synthesized after the interruption')

		const entries = yield* session.entries
		const childFinished = entries.findLast(
			(entry) => entry._tag === 'agent-finished' && entry.agentId === childStarted.agentId,
		)
		if (childFinished === undefined || childFinished._tag !== 'agent-finished') {
			throw new Error('expected the subagent terminal marker')
		}
		expect(childFinished.outcome).toBe('interrupted')

		const toolResult = entries.find((entry) => entry._tag === 'tool-result')
		const rendered = JSON.stringify(toolResult)
		expect(rendered).toContain(`agent_id: ${shortAgentId(childStarted.agentId)}`)
		expect(rendered).toContain('This subagent was interrupted')
		expect(rendered).not.toContain('The user interrupted the execution of this tool call.')
	}).pipe(Effect.scoped),
)
