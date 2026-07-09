/**
 * Slice-2 send-targeting tests (D8): `send` on a RUNNING agent queues a follow-up that joins the run
 * at its natural completion boundary (both senders resolve with the same final entry); a follow-up the
 * run never consumed (it stopped first) starts its own fresh run; and `send(text, { agentId })` on a
 * FINISHED subagent continues that agent's loop directly - rows under a null toolCallId, no new
 * agent_started, full prior context. Unknown ids fail typed.
 */
import { expect, it } from '@effect/vitest'
import { Context, Effect, Fiber, Layer } from 'effect'

import {
	AgentId,
	defineAgent,
	defineSubagent,
	EventLog,
	eventLogSource,
	layerInMemoryEventLog,
	shortAgentId,
	startSession,
	subagentTool,
	ToolCallId,
	type UserMessageLogEntry,
} from '../../src/index'
import { subagentStartedEntries } from '../Subagents/DriveHarness'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { claudeActiveModel, gptActiveModel, scriptedModel } from './ApiTestHelpers'
import { makeGateTool } from './SessionControlHarness'

it.effect('send while running joins the run as a follow-up; both senders get the same final entry', () =>
	Effect.gen(function* () {
		const gate = yield* makeGateTool('gate')
		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([{ id: 'provider-call-1', name: 'gate', params: {} }]),
			textTurn('first answer'),
			textTurn('follow-up answer'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model: rootScripted.model, tools: [gate.tool] }),
		})

		const firstSend = yield* Effect.forkScoped(session.send('go'))
		yield* gate.invoked
		const secondSend = yield* Effect.forkScoped(session.send('one more thing'))
		yield* gate.release

		const firstFinished = yield* Fiber.join(firstSend)
		const secondFinished = yield* Fiber.join(secondSend)

		// One run: the follow-up drained at the natural completion boundary and the run continued.
		expect(firstFinished.outcome).toBe('completed')
		expect(firstFinished.resultText).toBe('follow-up answer')
		expect(secondFinished.seq).toBe(firstFinished.seq)

		const entries = yield* session.entries
		expect(entries.filter((entry) => entry._tag === 'agent-finished')).toHaveLength(1)

		// The follow-up's model call saw the whole run including the first answer.
		const prompts = yield* rootScripted.scripted.prompts
		const followUpPrompt = JSON.stringify(prompts[2])
		expect(followUpPrompt).toContain('first answer')
		expect(followUpPrompt).toContain('one more thing')
	}).pipe(Effect.scoped),
)

it.effect('a follow-up the stopped run never consumed starts its own fresh run', () =>
	Effect.gen(function* () {
		const gate = yield* makeGateTool('gate')
		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([{ id: 'provider-call-1', name: 'gate', params: {} }]),
			textTurn('fresh run answer'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model: rootScripted.model, tools: [gate.tool] }),
		})

		const firstSend = yield* Effect.forkScoped(session.send('go'))
		yield* gate.invoked
		const secondSend = yield* Effect.forkScoped(session.send('one more thing'))
		yield* session.stop('stop the first run')
		yield* gate.release

		const firstFinished = yield* Fiber.join(firstSend)
		expect(firstFinished.outcome).toBe('stopped')

		// The queued follow-up was abandoned by the stopped run, so send ran it as its own fresh run.
		const secondFinished = yield* Fiber.join(secondSend)
		expect(secondFinished.outcome).toBe('completed')
		expect(secondFinished.resultText).toBe('fresh run answer')

		const entries = yield* session.entries
		expect(entries.filter((entry) => entry._tag === 'agent-finished')).toHaveLength(2)
	}).pipe(Effect.scoped),
)

it.effect('send targeting a finished subagent continues it directly under a null envelope', () =>
	Effect.gen(function* () {
		const researcherScripted = yield* scriptedModel(claudeActiveModel, [
			textTurn('first findings'),
			textTurn('continued findings'),
		])
		const researcher = defineSubagent({
			name: 'researcher',
			description: 'explores',
			systemPrompt: 'You are a researcher.',
			model: researcherScripted.model,
		})

		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([
				{
					id: 'provider-call-1',
					name: 'subagent',
					params: { description: 'explore', prompt: 'map the module', agent: 'researcher' },
				},
			]),
			textTurn('root done'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model: rootScripted.model, tools: [subagentTool([researcher])] }),
		})

		yield* session.send('go')
		const afterDispatch = yield* session.entries
		const started = subagentStartedEntries(afterDispatch)[0]
		if (started === undefined) throw new Error('expected the dispatched subagent to have started')

		const continued = yield* session.send('quote the title line', { agentId: started.agentId })
		expect(continued.outcome).toBe('completed')
		expect(continued.resultText).toBe('continued findings')
		expect(continued.agentId).toBe(started.agentId)

		// D8: the SDK continuation has no dispatching tool call - null envelope, no new agent_started.
		expect(continued.toolCallId).toBeNull()
		expect(continued.parentAgentId).toBeNull()
		const entries = yield* session.entries
		expect(subagentStartedEntries(entries)).toHaveLength(1)
		const continuationMessage = entries.findLast(
			(entry): entry is UserMessageLogEntry => entry._tag === 'user-message' && entry.agentId === started.agentId,
		)
		expect(continuationMessage?.toolCallId).toBeNull()

		// The continuation's model call carried the full prior context.
		const prompts = yield* researcherScripted.scripted.prompts
		const continuedPrompt = JSON.stringify(prompts[1])
		expect(continuedPrompt).toContain('map the module')
		expect(continuedPrompt).toContain('first findings')
		expect(continuedPrompt).toContain('quote the title line')
	}).pipe(Effect.scoped),
)

it.effect('send to an unknown agent id fails typed', () =>
	Effect.gen(function* () {
		const rootScripted = yield* scriptedModel(gptActiveModel, [])
		const session = yield* startSession({ agent: defineAgent({ model: rootScripted.model }) })

		const failure = yield* session
			.send('hello?', { agentId: AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa') })
			.pipe(Effect.flip)
		expect(failure._tag).toBe('SubagentNotFoundError')
	}).pipe(Effect.scoped),
)

it.effect('send targeting a finished subagent by its SHORT id continues it like the full id', () =>
	Effect.gen(function* () {
		const researcherScripted = yield* scriptedModel(claudeActiveModel, [
			textTurn('first findings'),
			textTurn('continued findings'),
		])
		const researcher = defineSubagent({
			name: 'researcher',
			description: 'explores',
			systemPrompt: 'You are a researcher.',
			model: researcherScripted.model,
		})

		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([
				{
					id: 'provider-call-1',
					name: 'subagent',
					params: { description: 'explore', prompt: 'map the module', agent: 'researcher' },
				},
			]),
			textTurn('root done'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model: rootScripted.model, tools: [subagentTool([researcher])] }),
		})

		yield* session.send('go')
		const started = subagentStartedEntries(yield* session.entries)[0]
		if (started === undefined) throw new Error('expected the dispatched subagent to have started')

		// The user-facing short reference resolves at the facade seam to the full id the controls use.
		const continued = yield* session.send('quote the title line', { agentId: shortAgentId(started.agentId) })
		expect(continued.outcome).toBe('completed')
		expect(continued.agentId).toBe(started.agentId)
		expect(continued.resultText).toBe('continued findings')
		expect(continued.toolCallId).toBeNull()
	}).pipe(Effect.scoped),
)

it.effect('send with an ambiguous short reference fails typed, naming the candidate short ids', () =>
	Effect.gen(function* () {
		// Seed the log with two started agents sharing the 6-char cuid prefix "abcdef" (diverging inside
		// the short id) so the reference "agent_abcdef" matches both.
		const logContext = yield* Layer.build(layerInMemoryEventLog)
		const sharedLog = Context.get(logContext, EventLog)

		const rootScripted = yield* scriptedModel(gptActiveModel, [])
		const session = yield* startSession({
			agent: defineAgent({ model: rootScripted.model }),
			log: eventLogSource(Effect.succeed(sharedLog)),
		})

		yield* Effect.forEach(
			[AgentId.make(`agent_abcdef11${'0'.repeat(16)}`), AgentId.make(`agent_abcdef22${'0'.repeat(16)}`)],
			(agentId, index) =>
				sharedLog
					.append({
						_tag: 'agent_started',
						agentId,
						parentAgentId: session.rootAgentId,
						toolCallId: ToolCallId.make(`tool_call_${String(index).repeat(24)}`),
						mode: 'fresh',
						model: claudeActiveModel,
						tools: [],
						skill: null,
						fork: null,
						agentType: null,
					})
					.pipe(Effect.orDie),
			{ discard: true },
		)

		const failure = yield* session.send('hello?', { agentId: 'agent_abcdef' }).pipe(Effect.flip)
		expect(failure._tag).toBe('SubagentNotFoundError')
		expect(failure.requested).toBe('agent_abcdef')
		expect(failure.candidates).toEqual(['agent_abcdef11', 'agent_abcdef22'])
	}).pipe(Effect.scoped),
)
