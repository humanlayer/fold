/**
 * Engine test for resume-across-restart by log replay (D21): session A dispatches a subagent over a
 * shared EventLog and CLOSES; session B - a fresh session instance with no in-memory state from A -
 * opens over the same log and resumes the subagent by agent_id through the real tool wire. The resumed
 * prompt, turn totals, and envelope all come purely from replaying A's rows, which is exactly the
 * process-restart story at the storage seam (tart-agent's JSONL backend persists the same seam to disk).
 */
import { expect, it } from '@effect/vitest'
import { Context, Effect, Layer } from 'effect'

import {
	defineAgent,
	defineSubagent,
	EventLog,
	eventLogSource,
	layerInMemoryEventLog,
	shortAgentId,
	startSession,
	subagentTool,
	type AgentId,
	type UserMessageLogEntry,
} from '../../src/index'
import { claudeActiveModel, gptActiveModel, scriptedModel } from '../Api/ApiTestHelpers'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { renderedDriveResult, subagentStartedEntries } from './DriveHarness'

it.effect("a new session over the same log resumes a prior session's subagent purely by replay", () =>
	Effect.gen(function* () {
		// One log service outliving both sessions - the in-memory stand-in for a JSONL file on disk.
		const logContext = yield* Layer.build(layerInMemoryEventLog)
		const sharedLog = Context.get(logContext, EventLog)
		const sharedLogSource = eventLogSource(Effect.succeed(sharedLog))

		// --- session A: dispatch the researcher, then close the session entirely ---------------------
		const dispatched = yield* Effect.scoped(
			Effect.gen(function* () {
				const researcherScripted = yield* scriptedModel(claudeActiveModel, [textTurn('first findings')])
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
					textTurn('root A done'),
				])

				const session = yield* startSession({
					agent: defineAgent({
						model: rootScripted.model,
						systemPrompt: 'root',
						tools: [subagentTool([researcher])],
					}),
					log: sharedLogSource,
				})

				const finished = yield* session.send('go')
				expect(finished.outcome).toBe('completed')

				const entries = yield* session.entries
				const started = subagentStartedEntries(entries)[0]
				if (started === undefined) throw new Error('expected the dispatched subagent to have started')
				return { agentId: started.agentId }
			}),
		)

		// --- session B: fresh instance, fresh definitions/models, same log ---------------------------
		const resumedScripted = yield* scriptedModel(claudeActiveModel, [textTurn('resumed findings')])
		const researcherB = defineSubagent({
			name: 'researcher',
			description: 'explores',
			systemPrompt: 'You are a researcher.',
			model: resumedScripted.model,
		})

		// The resume id is data from A's log, so B's script is fully static.
		const rootBScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([
				{
					id: 'provider-call-1',
					name: 'subagent',
					params: { description: 'follow up', prompt: 'pick it back up', agent_id: dispatched.agentId },
				},
			]),
			textTurn('root B done'),
		])

		const sessionB = yield* startSession({
			agent: defineAgent({
				model: rootBScripted.model,
				systemPrompt: 'root',
				tools: [subagentTool([researcherB])],
			}),
			log: sharedLogSource,
		})

		const finishedB = yield* sessionB.send('continue where we left off')
		expect(finishedB.outcome).toBe('completed')

		const entries = yield* sessionB.entries

		// Two session_started rows (an honest restart marker), but still exactly ONE subagent start.
		expect(entries.filter((entry) => entry._tag === 'session_started')).toHaveLength(2)
		expect(subagentStartedEntries(entries)).toHaveLength(1)

		// The resumed model call reconstructed A's context purely from the log rows.
		const prompts = yield* resumedScripted.scripted.prompts
		const resumedPrompt = JSON.stringify(prompts[0])
		expect(resumedPrompt).toContain('You are a researcher.')
		expect(resumedPrompt).toContain('map the module')
		expect(resumedPrompt).toContain('first findings')
		expect(resumedPrompt).toContain('pick it back up')

		// The resumed rows carry session B's dispatcher as parent, under the RESUMING tool call.
		const rootStartedRows = entries.filter(
			(entry) => entry._tag === 'agent_started' && entry.parentAgentId === null,
		)
		const rootB = rootStartedRows[1]
		if (rootB?._tag !== 'agent_started') throw new Error("expected session B's root agent_started")
		const researcherUserMessages = entries.filter(
			(entry): entry is UserMessageLogEntry =>
				entry._tag === 'user-message' && entry.agentId === (dispatched.agentId satisfies AgentId),
		)
		expect(researcherUserMessages).toHaveLength(2)
		expect(researcherUserMessages[1]?.parentAgentId).toBe(rootB.agentId)
		expect(researcherUserMessages[1]?.toolCallId).not.toBe(researcherUserMessages[0]?.toolCallId)

		// Turn totals fold across both sessions' rows: 1 this run, 2 lifetime.
		const rendered = renderedDriveResult(entries, 1)
		expect(rendered).toContain(`agent_id: ${shortAgentId(dispatched.agentId)}`)
		expect(rendered).toContain('turns: 1 this run (2 total)')
		expect(rendered).toContain('resumed findings')
	}).pipe(Effect.scoped),
)
