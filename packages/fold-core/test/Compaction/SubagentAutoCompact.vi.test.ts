/**
 * Subagent auto-compaction tests (D11 x D21): the session-wide compaction policy applies to every
 * agent, but each agent compacts against its OWN projection with its own model - a dispatched
 * subagent's compaction entry lands under the child's envelope and never leaks into the parent's
 * context, and a FORK can compact history that includes the parent's folded range without touching
 * the parent's own view (global seq keeps the cut coherent - the worked D21 claim).
 */
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import {
	defineAgent,
	defineSubagent,
	messagesForAgent,
	startSession,
	subagentTool,
	type AgentStartedLogEntry,
	type AutoCompactConfig,
	type CompactionLogEntry,
	type LogEntry,
} from '../../src/index'
import { claudeActiveModel, echoTool, gptActiveModel, scriptedModel } from '../Api/ApiTestHelpers'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'

const compactConfig: AutoCompactConfig = { enabled: true, contextWindow: 10_000, keepRecentTokens: 10 }

const hugeUsage = { inputTokens: 7_000 }

const compactionEntries = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<CompactionLogEntry> =>
	entries.filter((entry): entry is CompactionLogEntry => entry._tag === 'compaction')

const subagentStarted = (entries: ReadonlyArray<LogEntry>): AgentStartedLogEntry => {
	const started = entries.find(
		(entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started' && entry.parentAgentId !== null,
	)
	if (started === undefined) throw new Error('expected a subagent agent_started entry')
	return started
}

it.effect('a dispatched subagent compacts its own context; the parent projection never sees it', () =>
	Effect.gen(function* () {
		const researcherScripted = yield* scriptedModel(claudeActiveModel, [
			// Child turn 1 reports huge usage; child turn 2 opens with the summarization call.
			toolCallTurn([{ id: 'child-call-1', name: 'echo', params: { text: 'y'.repeat(100) } }], hugeUsage),
			textTurn('## Goal\n- child summary'),
			textTurn('child findings done'),
		])
		const researcher = defineSubagent({
			name: 'researcher',
			description: 'Read-only exploration.',
			systemPrompt: 'You are a researcher.',
			model: researcherScripted.model,
			tools: [echoTool],
		})

		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([
				{
					id: 'provider-call-1',
					name: 'subagent',
					params: { description: 'investigate', prompt: 'investigate the flaky test', agent: 'researcher' },
				},
			]),
			textTurn('root synthesis'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				model: rootScripted.model,
				systemPrompt: 'You are the root agent.',
				tools: [subagentTool([researcher])],
				// One session-wide policy (D11): the child compacts under it too, with its own model.
				autoCompact: compactConfig,
			}),
		})

		const finished = yield* session.send('dispatch the researcher')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('root synthesis')

		// Exactly one compaction: the child's, grouped under the dispatching call's envelope (D2).
		const child = subagentStarted(entries)
		const compactions = compactionEntries(entries)
		expect(compactions).toHaveLength(1)
		expect(compactions[0]?.agentId).toBe(child.agentId)
		expect(compactions[0]?.parentAgentId).toBe(child.parentAgentId)
		expect(compactions[0]?.toolCallId).toBe(child.toolCallId)

		// The child's post-compaction request: its summary stands in for the dispatch prompt, its own
		// leading prompt survives - and the summarization ran on the CHILD's model (its script).
		const childRequests = yield* researcherScripted.scripted.prompts
		const childSummarize = JSON.stringify(childRequests[1])
		expect(childSummarize).toContain('[User]: investigate the flaky test')
		const childFinal = JSON.stringify(childRequests[2])
		expect(childFinal).toContain('<conversation-summary>')
		expect(childFinal).toContain('child summary')
		expect(childFinal).not.toContain('investigate the flaky test')
		expect(childFinal).toContain('You are a researcher.')

		// The parent's context is untouched: its own history intact, no summary anywhere.
		const rootRequests = yield* rootScripted.scripted.prompts
		const rootFinal = JSON.stringify(rootRequests[1])
		expect(rootFinal).toContain('dispatch the researcher')
		expect(rootFinal).not.toContain('<conversation-summary>')

		// Projection read models agree per agent.
		expect(messagesForAgent(entries, session.rootAgentId).some((m) => m._tag === 'compaction-summary')).toBe(false)
		expect(messagesForAgent(entries, child.agentId).some((m) => m._tag === 'compaction-summary')).toBe(true)

		expect(yield* researcherScripted.scripted.remainingTurns).toBe(0)
		expect(yield* rootScripted.scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

it.effect('a fork compacts history including the parent folded range without touching the parent view', () =>
	Effect.gen(function* () {
		// The fork clones the root, so ONE script drives both agents, in strict causal order:
		// send 1 root turn, send 2 root turn (fork dispatch), fork turn 1 (huge usage), the fork's
		// summarization call, fork turn 2 (result), then the root's closing turn.
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			textTurn(`parent knows: the launch code is 4242. ${'k'.repeat(120)}`),
			toolCallTurn([
				{
					id: 'provider-call-1',
					name: 'subagent',
					params: { description: 'fork work', prompt: 'continue the analysis in a fork', fork: true },
				},
			]),
			toolCallTurn([{ id: 'fork-call-1', name: 'echo', params: { text: 'z'.repeat(100) } }], hugeUsage),
			textTurn('## Goal\n- fork summary'),
			textTurn('fork result ready'),
			textTurn('root closing words'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				model,
				systemPrompt: 'You are the root agent.',
				tools: [echoTool, subagentTool([])],
				autoCompact: compactConfig,
			}),
		})

		yield* session.send('give me the parent context')
		const finished = yield* session.send('spawn a fork')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('root closing words')

		// The fork's compaction cut reaches back past its fork point: replacesThroughSeq covers the
		// parent's folded history (everything at or below it stops rendering FOR THE FORK).
		const fork = subagentStarted(entries)
		expect(fork.mode).toBe('fork')
		const compactions = compactionEntries(entries)
		expect(compactions).toHaveLength(1)
		expect(compactions[0]?.agentId).toBe(fork.agentId)
		const atSeq = fork.fork?.atSeq
		if (atSeq === undefined) throw new Error('expected fork provenance')
		expect(compactions[0]?.replacesThroughSeq).toBeGreaterThan(atSeq)

		const prompts = yield* scripted.prompts

		// The fork's summarization saw the folded parent content - it IS part of what gets summarized.
		const forkSummarize = JSON.stringify(prompts[3])
		expect(forkSummarize).toContain('launch code is 4242')

		// The fork's post-compaction request: summary in place, folded parent content gone.
		const forkFinal = JSON.stringify(prompts[4])
		expect(forkFinal).toContain('fork summary')
		expect(forkFinal).not.toContain('launch code is 4242')

		// The parent's next request still carries its full own history: the fork's compaction is
		// agent-scoped, and global seq keeps the two views coherent over one flat log (D21).
		const rootClosing = JSON.stringify(prompts[5])
		expect(rootClosing).toContain('launch code is 4242')
		expect(rootClosing).not.toContain('<conversation-summary>')
		expect(messagesForAgent(entries, session.rootAgentId).some((m) => m._tag === 'compaction-summary')).toBe(false)

		expect(yield* scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)
