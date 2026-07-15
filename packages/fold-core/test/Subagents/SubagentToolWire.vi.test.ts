/**
 * Engine tests for the REAL subagent tool wire (D21): the model dispatches and resumes subagents by
 * calling the `subagent` tool with its flat wire parameters - no test-only drive tool in the loop - so
 * these prove the whole path the SDK ships: wire params -> parseSubagentCommand -> Subagents engine ->
 * rendered durable result. The resume turn's agent_id is only known after the dispatch, so the root's
 * script is extended between sends (`pushTurns`). Malformed commands (no selector, garbage agent_id,
 * unknown agent_id) come back as instructive tool failures the model can correct from.
 */
import { expect, it } from '@effect/vitest'
import { Context, Effect, Layer } from 'effect'

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
import { claudeActiveModel, gptActiveModel, scriptedModel } from '../Api/ApiTestHelpers'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { renderedDriveResult, subagentStartedEntries } from './DriveHarness'

it.effect('the model resumes a subagent through the tool wire by its SHORT id: full context, new call', () =>
	Effect.gen(function* () {
		const researcherScripted = yield* scriptedModel(claudeActiveModel, [
			textTurn('first findings'),
			textTurn('resumed findings'),
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
					params: { description: 'map module', prompt: 'map the module', agent: 'researcher' },
				},
			]),
			textTurn('synthesized'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				model: rootScripted.model,
				systemPrompt: 'root',
				tools: [subagentTool([researcher])],
			}),
		})

		const firstFinished = yield* session.send('go')
		expect(firstFinished.outcome).toBe('completed')

		const afterDispatch = yield* session.entries
		const started = subagentStartedEntries(afterDispatch)[0]
		if (started === undefined) throw new Error('expected the dispatched subagent to have started')

		// The resume turn embeds the SHORT agent_id, exactly as a model reads it off the first result's
		// `agent_id:` line - the engine resolves the unique prefix back to the full id.
		yield* rootScripted.scripted.pushTurns([
			toolCallTurn([
				{
					id: 'provider-call-2',
					name: 'subagent',
					params: { description: 'follow up', prompt: 'keep going', agent_id: shortAgentId(started.agentId) },
				},
			]),
			textTurn('synthesized again'),
		])

		const secondFinished = yield* session.send('continue with the researcher')
		expect(secondFinished.outcome).toBe('completed')

		const entries = yield* session.entries

		// Resume through the wire wrote no second agent_started and grouped rows under the resuming call.
		expect(subagentStartedEntries(entries)).toHaveLength(1)
		const researcherUserMessages = entries.filter(
			(entry): entry is UserMessageLogEntry => entry._tag === 'user-message' && entry.agentId === started.agentId,
		)
		expect(researcherUserMessages).toHaveLength(2)
		expect(researcherUserMessages[1]?.toolCallId).not.toBeNull()
		expect(researcherUserMessages[1]?.toolCallId).not.toBe(researcherUserMessages[0]?.toolCallId)

		// The resumed model call saw the full prior context plus the wire prompt.
		const prompts = yield* researcherScripted.scripted.prompts
		const resumedPrompt = JSON.stringify(prompts[1])
		expect(resumedPrompt).toContain('map the module')
		expect(resumedPrompt).toContain('first findings')
		expect(resumedPrompt).toContain('keep going')

		// The rendered resume result reports the short id and per-run/lifetime turn counts.
		const rendered = renderedDriveResult(entries, 1)
		expect(rendered).toContain(`agent_id: ${shortAgentId(started.agentId)}`)
		expect(rendered).toContain('turns: 1 this run (2 total)')
		expect(rendered).toContain('resumed findings')

		expect(yield* rootScripted.scripted.remainingTurns).toBe(0)
		expect(yield* researcherScripted.scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

it.effect('malformed wire commands come back as instructive tool failures the model can correct from', () =>
	Effect.gen(function* () {
		const researcherScripted = yield* scriptedModel(claudeActiveModel, [])
		const researcher = defineSubagent({
			name: 'researcher',
			description: 'explores',
			model: researcherScripted.model,
		})

		// Three bad calls in sequence: no selector, a garbage id, and a well-formed id no agent ever had.
		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([
				{
					id: 'provider-call-1',
					name: 'subagent',
					params: { description: 'oops', prompt: 'do something' },
				},
			]),
			toolCallTurn([
				{
					id: 'provider-call-2',
					name: 'subagent',
					params: { description: 'oops', prompt: 'do something', agent_id: 'not-an-id' },
				},
			]),
			toolCallTurn([
				{
					id: 'provider-call-3',
					name: 'subagent',
					params: {
						description: 'oops',
						prompt: 'do something',
						agent_id: 'agent_aaaaaaaaaaaaaaaaaaaaaaaa',
					},
				},
			]),
			textTurn('gave up gracefully'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model: rootScripted.model, tools: [subagentTool([researcher])] }),
		})

		const finished = yield* session.send('go')
		expect(finished.outcome).toBe('completed')

		const entries = yield* session.entries
		expect(subagentStartedEntries(entries)).toHaveLength(0) // nothing ever dispatched

		expect(renderedDriveResult(entries, 0)).toContain('Provide exactly one of agent')
		expect(renderedDriveResult(entries, 1)).toContain('is not a valid subagent id')
		expect(renderedDriveResult(entries, 2)).toContain('No subagent with agent_id')

		expect(yield* rootScripted.scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

it.effect('an ambiguous short agent_id comes back as an instructive failure naming the candidate short ids', () =>
	Effect.gen(function* () {
		// A shared log the test can seed directly: two started agents whose cuid segments share the
		// 6-character prefix "abcdef" but diverge inside the 8-character short id, so the short ref
		// "agent_abcdef" matches both and the candidates the failure names are distinguishable.
		const logContext = yield* Layer.build(layerInMemoryEventLog)
		const sharedLog = Context.get(logContext, EventLog)

		const researcherScripted = yield* scriptedModel(claudeActiveModel, [])
		const researcher = defineSubagent({
			name: 'researcher',
			description: 'explores',
			model: researcherScripted.model,
		})

		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([
				{
					id: 'provider-call-1',
					name: 'subagent',
					params: { description: 'follow up', prompt: 'keep going', agent_id: 'agent_abcdef' },
				},
			]),
			textTurn('understood, asking for more characters'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model: rootScripted.model, tools: [subagentTool([researcher])] }),
			log: eventLogSource(Effect.succeed(sharedLog)),
		})

		const rootStarted = (yield* session.entries).find(
			(entry) => entry._tag === 'agent_started' && entry.parentAgentId === null,
		)
		if (rootStarted?._tag !== 'agent_started') throw new Error('expected the root agent_started row')

		const twinIds = [
			AgentId.make(`agent_abcdef11${'0'.repeat(16)}`),
			AgentId.make(`agent_abcdef22${'0'.repeat(16)}`),
		]
		yield* Effect.forEach(
			twinIds,
			(agentId, index) =>
				sharedLog
					.append({
						_tag: 'agent_started',
						agentId,
						parentAgentId: rootStarted.agentId,
						toolCallId: ToolCallId.make(`tool_call_${String(index).repeat(24)}`),
						mode: 'fresh',
						model: claudeActiveModel,
						tools: [],
						skill: null,
						fork: null,
						agentType: 'researcher',
					})
					.pipe(Effect.orDie),
			{ discard: true },
		)

		const finished = yield* session.send('go')
		expect(finished.outcome).toBe('completed')

		const entries = yield* session.entries
		const rendered = renderedDriveResult(entries, 0)
		expect(rendered).toContain('is ambiguous')
		expect(rendered).toContain('matches 2 agents')
		expect(rendered).toContain('agent_abcdef11')
		expect(rendered).toContain('agent_abcdef22')
		expect(rendered).toContain('Provide more characters')

		// Nothing resumed: the failure fired before any subagent run.
		expect(yield* researcherScripted.scripted.remainingTurns).toBe(0)
		expect(yield* rootScripted.scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)
