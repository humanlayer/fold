/**
 * Slice-2 session-stop tests (D9): `stop` raises a session-wide graceful-stop signal every agent's
 * loop observes at its batch boundaries - the in-flight batch finishes and its results land, then the
 * run ends with `agent-finished{stopped}` and no further model call. The signal reaches the whole tree
 * (a running subagent stops at ITS boundary and the dispatcher follows at its own), and it clears when
 * the next send begins.
 */
import { expect, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'

import { defineAgent, defineSubagent, startSession, subagentTool } from '../../src/index'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { claudeActiveModel, gptActiveModel, scriptedModel } from './ApiTestHelpers'
import { makeGateTool } from './SessionControlHarness'

it.effect('stop lets the in-flight batch finish, then ends the run with no further model call', () =>
	Effect.gen(function* () {
		const gate = yield* makeGateTool('gate')
		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([{ id: 'provider-call-1', name: 'gate', params: {} }]),
			textTurn('never requested'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model: rootScripted.model, tools: [gate.tool] }),
		})

		const sendFiber = yield* Effect.forkScoped(session.send('go'))
		yield* gate.invoked
		yield* session.stop('the user hit stop')
		yield* gate.release

		const finished = yield* Fiber.join(sendFiber)
		expect(finished.outcome).toBe('stopped')
		expect(finished.reason).toBe('the user hit stop')

		// The batch's results are facts in the log; the second scripted turn was never consumed.
		const entries = yield* session.entries
		expect(entries.some((entry) => entry._tag === 'tool-result')).toBe(true)
		expect(yield* rootScripted.scripted.remainingTurns).toBe(1)

		// The signal clears on the next send: the remaining turn now runs to completion.
		const next = yield* session.send('carry on')
		expect(next.outcome).toBe('completed')
		expect(next.resultText).toBe('never requested')
	}).pipe(Effect.scoped),
)

it.effect('stop reaches the whole tree: the running subagent stops, then its dispatcher stops', () =>
	Effect.gen(function* () {
		const gate = yield* makeGateTool('gate')
		const researcherScripted = yield* scriptedModel(claudeActiveModel, [
			toolCallTurn([{ id: 'child-call-1', name: 'gate', params: {} }]),
			textTurn('never requested (child)'),
		])
		const researcher = defineSubagent({
			name: 'researcher',
			description: 'explores',
			model: researcherScripted.model,
			tools: [gate.tool],
		})

		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([
				{
					id: 'provider-call-1',
					name: 'subagent',
					params: { description: 'explore', prompt: 'explore the module', agent: 'researcher' },
				},
			]),
			textTurn('never requested (root)'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model: rootScripted.model, tools: [subagentTool([researcher])] }),
		})

		const sendFiber = yield* Effect.forkScoped(session.send('go'))
		yield* gate.invoked
		yield* session.stop('stop everything')
		yield* gate.release

		const finished = yield* Fiber.join(sendFiber)
		expect(finished.outcome).toBe('stopped')
		expect(finished.reason).toBe('stop everything')

		// The child wrote its own stopped marker at ITS batch boundary...
		const entries = yield* session.entries
		const childStarted = entries.find((entry) => entry._tag === 'agent_started' && entry.parentAgentId !== null)
		if (childStarted === undefined || childStarted._tag !== 'agent_started') {
			throw new Error('expected the dispatched subagent to have started')
		}
		const childFinished = entries.findLast(
			(entry) => entry._tag === 'agent-finished' && entry.agentId === childStarted.agentId,
		)
		if (childFinished === undefined || childFinished._tag !== 'agent-finished') {
			throw new Error('expected the subagent terminal marker')
		}
		expect(childFinished.outcome).toBe('stopped')

		// ...and the dispatcher's rendered result surfaces the stopped outcome honestly. (The child's
		// own gate tool-result is also in the log; the dispatcher's is the root-owned one.)
		const dispatchResult = entries.find((entry) => entry._tag === 'tool-result' && entry.parentAgentId === null)
		expect(JSON.stringify(dispatchResult)).toContain('stopped early')

		// Neither model consumed its post-stop turn.
		expect(yield* researcherScripted.scripted.remainingTurns).toBe(1)
		expect(yield* rootScripted.scripted.remainingTurns).toBe(1)
	}).pipe(Effect.scoped),
)
