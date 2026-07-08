/**
 * Engine tests for fresh subagent dispatch (D21) through the public facade: the subagent runs its own
 * scripted model on the SAME session log, every one of its rows carries the dispatching parent id and
 * tool call id, its leading prompt is its own (family base + definition blocks), and the dispatcher's
 * durable tool result renders the agent_id + turns header and the <subagent_result> body.
 */
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import {
	defineAgent,
	defineSubagent,
	startSession,
	subagentTool,
	type AgentStartedLogEntry,
	type LogEntry,
	type ToolResultLogEntry,
} from '../../src/index'
import { claudeActiveModel, gptActiveModel, scriptedModel } from '../Api/ApiTestHelpers'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'

const toolResultText = (entry: ToolResultLogEntry): string => {
	const part = entry.message.content[0]
	if (part === undefined || part.type !== 'tool-result') throw new Error('expected a tool-result part')
	return JSON.stringify(part.result)
}

it.effect('dispatches a fresh subagent on the shared log and renders its result', () =>
	Effect.gen(function* () {
		const researcherScripted = yield* scriptedModel(claudeActiveModel, [textTurn('findings: all good')])
		const researcher = defineSubagent({
			name: 'researcher',
			description: 'Read-only codebase exploration.',
			systemPrompt: 'You are a researcher.',
			model: researcherScripted.model,
		})

		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([
				{
					id: 'provider-call-1',
					name: 'subagent',
					params: { description: 'map auth', prompt: 'map the auth module', agent: 'researcher' },
				},
			]),
			textTurn('synthesized'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				model: rootScripted.model,
				systemPrompt: 'You are the root agent.',
				tools: [subagentTool([researcher])],
			}),
		})

		const finished = yield* session.send('go')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('synthesized')

		// The whole tree lives on one flat log, in causal order.
		expect(entries.map((entry) => entry._tag)).toEqual([
			'session_started',
			'agent_started', // root
			'system-message', // root leading
			'user-message', // "go"
			'assistant-message', // root tool call
			'agent_started', // researcher (fresh dispatch)
			'system-message', // researcher leading
			'user-message', // dispatch prompt
			'assistant-message', // researcher text turn
			'agent-finished', // researcher completed
			'tool-result', // rendered subagent result for the root
			'assistant-message', // root "synthesized"
			'agent-finished', // root completed
		])

		// The subagent's rows carry the dispatching parent and the dispatching tool call (D2 envelope).
		const startedEntries = entries.filter((entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started')
		const rootStarted = startedEntries[0]
		const subagentStarted = startedEntries[1]
		if (rootStarted === undefined || subagentStarted === undefined) throw new Error('expected two agent_started')

		expect(subagentStarted.mode).toBe('fresh')
		expect(subagentStarted.agentType).toBe('researcher')
		expect(subagentStarted.parentAgentId).toBe(rootStarted.agentId)
		expect(subagentStarted.toolCallId).not.toBeNull()

		const subagentRows = entries.filter(
			(entry): entry is LogEntry & { readonly agentId: string } =>
				'agentId' in entry && entry.agentId === subagentStarted.agentId,
		)
		for (const row of subagentRows) {
			expect(row.parentAgentId).toBe(rootStarted.agentId)
			expect(row.toolCallId).toBe(subagentStarted.toolCallId)
		}

		// The researcher's model saw ITS leading prompt and the dispatch prompt - not the root's history.
		const researcherPrompts = yield* researcherScripted.scripted.prompts
		const firstResearcherPrompt = researcherPrompts[0]
		if (firstResearcherPrompt === undefined) throw new Error('expected a researcher request')
		const systemContents = firstResearcherPrompt.content
			.filter((message) => message.role === 'system')
			.map((message) => message.content)
			.join('\n')
		expect(systemContents).toContain('You are a researcher.')
		expect(systemContents).not.toContain('You are the root agent.')
		const userContents = firstResearcherPrompt.content.filter((message) => message.role === 'user')
		expect(JSON.stringify(userContents)).toContain('map the auth module')
		expect(JSON.stringify(userContents)).not.toContain('go')

		// The dispatcher's durable tool result carries the id + turns header and the result body.
		const toolResult = entries.find((entry): entry is ToolResultLogEntry => entry._tag === 'tool-result')
		if (toolResult === undefined) throw new Error('expected a tool-result entry')
		const rendered = toolResultText(toolResult)
		expect(rendered).toContain(`agent_id: ${subagentStarted.agentId}`)
		expect(rendered).toContain('turns: 1 this run (1 total)')
		expect(rendered).toContain('<subagent_result>')
		expect(rendered).toContain('findings: all good')
		expect(rendered).not.toContain('<system-information>')

		// Both scripts fully consumed: the subagent ran exactly one turn, the root exactly two.
		expect(yield* researcherScripted.scripted.remainingTurns).toBe(0)
		expect(yield* rootScripted.scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)
