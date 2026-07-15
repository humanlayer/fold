/**
 * Subagent orchestration demo: a root agent with NO filesystem tools delegates to a `researcher`
 * subagent that has read + bash over a scratch workspace, all on one JSONL-persisted log. The first
 * send dispatches the researcher; the second asks the root to RESUME it by the agent_id it read off
 * its own earlier tool result - the researcher answers the follow-up with its full prior context
 * intact, and the log shows one agent_started with rows grouped under two different tool calls.
 *
 * Run: ANTHROPIC_API_KEY=... bun packages/fold-agent/examples/SubagentsAgent.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { anthropicModel, defineAgent, defineSubagent, startSession, subagentTool } from '@humanlayer/fold-core'
import { Console, Effect } from 'effect'

import { bashTool, jsonlEventLog, readTool } from '../src/index'

const modelId = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'
const apiKey = process.env.ANTHROPIC_API_KEY

const makeProgram = (apiKey: string) =>
	Effect.gen(function* () {
		const workspace = mkdtempSync(join(tmpdir(), 'fold-subagents-demo-'))
		const logPath = join(workspace, 'session.jsonl')
		writeFileSync(
			join(workspace, 'ADR-001.md'),
			'# ADR-001: One flat event log per session\n\nEvery agent in a session, subagents included, ' +
				"appends to one flat log; projections rebuild any agent's context by folding its rows.\n",
		)
		writeFileSync(
			join(workspace, 'config.ts'),
			'export const config = { retries: 3, timeoutMs: 30_000, provider: "anthropic" }\n',
		)
		yield* Console.log(`workspace: ${workspace}`)

		const model = anthropicModel({ model: modelId, apiKey, reasoning: 'medium' })

		const researcher = defineSubagent({
			name: 'researcher',
			description: 'Read-only workspace exploration: reads files and runs read-only bash.',
			systemPrompt:
				'You are a researcher working in the current directory. Explore with your tools and ' +
				'answer concisely. Never modify anything.',
			model,
			tools: [readTool({ cwd: workspace }), bashTool({ cwd: workspace })],
		})

		// The root is a pure orchestrator: its ONLY tool is the subagent tool over its roster.
		const session = yield* startSession({
			agent: defineAgent({
				name: 'subagents-demo',
				model,
				systemPrompt:
					'You are an orchestrator with no direct filesystem access. Delegate all inspection ' +
					'to your subagents and synthesize short answers from their results.',
				tools: [subagentTool([researcher])],
			}),
			log: jsonlEventLog(logPath),
			cwd: workspace,
		})

		const first = yield* session.send(
			'Dispatch the researcher to list what is in this workspace and summarize each file in one line.',
		)
		yield* Console.log(`\nfirst send:  ${first.outcome}\n${first.resultText ?? '(no text)'}`)

		// The root already holds the researcher's agent_id in its context (the tool result names it),
		// so resuming is just an instruction - the model passes agent_id back over the tool wire.
		const second = yield* session.send(
			'Resume that same researcher (use the agent_id from its result) and ask it to quote the ' +
				'title line of ADR-001.md exactly.',
		)
		yield* Console.log(`\nsecond send: ${second.outcome}\n${second.resultText ?? '(no text)'}`)

		// Read the story back off the durable log: one subagent, resumed under a second tool call.
		const entries = yield* session.entries
		const subagentStarts = entries.filter((entry) => entry._tag === 'agent_started' && entry.parentAgentId !== null)
		const researcherId = subagentStarts[0]?._tag === 'agent_started' ? subagentStarts[0].agentId : null
		const researcherTurns = entries.filter(
			(entry) => entry._tag === 'assistant-message' && entry.agentId === researcherId,
		).length
		const researcherCalls = new Set(
			entries
				.filter((entry) => entry._tag === 'user-message' && entry.agentId === researcherId)
				.map((entry) => entry.toolCallId),
		).size

		yield* Console.log(`\nlog: ${entries.length} rows persisted to ${logPath}`)
		yield* Console.log(`subagents started: ${subagentStarts.length} (researcher: ${researcherId ?? 'none'})`)
		yield* Console.log(`researcher turns: ${researcherTurns} across ${researcherCalls} dispatch/resume calls`)
	}).pipe(Effect.scoped)

if (apiKey === undefined || apiKey === '') {
	console.error('Set ANTHROPIC_API_KEY to run this example.')
	process.exitCode = 1
} else {
	Effect.runPromise(makeProgram(apiKey)).catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
