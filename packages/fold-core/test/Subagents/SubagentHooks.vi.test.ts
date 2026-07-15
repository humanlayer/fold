/**
 * Engine tests for per-subagent hooks (round-four ruling 6) and per-agent state isolation (D4): each
 * agent runs its OWN hook chains (the root's hooks never fire for a subagent's tool calls and vice
 * versa), and hook/tool KV state is scoped by agent in the log - a namespace written on one agent is
 * invisible in another agent's fold of the same namespace.
 */
import { expect, it } from '@effect/vitest'
import { Effect, Ref, Schema } from 'effect'

import {
	defineAgent,
	defineSubagent,
	defineToolState,
	startSession,
	subagentTool,
	toolStateForAgent,
	type PreToolUseHook,
} from '../../src/index'
import { claudeActiveModel, gptActiveModel, makeRecordedTool, scriptedModel } from '../Api/ApiTestHelpers'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { subagentStartedEntries } from './DriveHarness'

const ProbeState = defineToolState({
	namespace: 'probe',
	keys: { marker: Schema.String },
})

/** A preToolUse hook that records tool names it saw and stamps the probe namespace with a marker. */
const makeRecordingHook = (name: string, seen: Ref.Ref<ReadonlyArray<string>>, marker: string): PreToolUseHook => ({
	name,
	handler: (input) =>
		Effect.gen(function* () {
			yield* Ref.update(seen, (names) => [...names, input.toolName])
			yield* ProbeState.set('marker', marker)

			return { _tag: 'continue' as const, params: input.params }
		}),
})

it.effect('root and subagent run their own hook chains, and hook state stays per-agent', () =>
	Effect.gen(function* () {
		const rootHookSaw = yield* Ref.make<ReadonlyArray<string>>([])
		const subagentHookSaw = yield* Ref.make<ReadonlyArray<string>>([])

		const researcherTool = yield* makeRecordedTool('probe_tool')
		const researcherScripted = yield* scriptedModel(claudeActiveModel, [
			toolCallTurn([{ id: 'c1', name: 'probe_tool', params: { text: 'hi' } }]),
			textTurn('researcher done'),
		])
		const researcher = defineSubagent({
			name: 'researcher',
			description: 'explores',
			model: researcherScripted.model,
			tools: [researcherTool.tool],
			hooks: { preToolUse: [makeRecordingHook('subagent-recorder', subagentHookSaw, 'from-subagent')] },
		})

		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([
				{ id: 'r1', name: 'subagent', params: { description: 'd', prompt: 'explore', agent: 'researcher' } },
			]),
			textTurn('root done'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				model: rootScripted.model,
				tools: [subagentTool([researcher])],
				hooks: { preToolUse: [makeRecordingHook('root-recorder', rootHookSaw, 'from-root')] },
			}),
		})

		const finished = yield* session.send('go')
		expect(finished.outcome).toBe('completed')

		// The root's hook saw only the root's tool calls; the subagent's hook only the subagent's.
		expect(yield* Ref.get(rootHookSaw)).toEqual(['subagent'])
		expect(yield* Ref.get(subagentHookSaw)).toEqual(['probe_tool'])

		// Per-agent KV isolation (D4): each agent's probe namespace holds only its own marker.
		const entries = yield* session.entries
		const rootStarted = entries.find((entry) => entry._tag === 'agent_started' && entry.parentAgentId === null)
		const subagentStarted = subagentStartedEntries(entries)[0]
		if (rootStarted?._tag !== 'agent_started' || subagentStarted === undefined) {
			throw new Error('expected both agents to have started')
		}

		expect(toolStateForAgent(entries, rootStarted.agentId, 'probe')).toEqual({ marker: 'from-root' })
		expect(toolStateForAgent(entries, subagentStarted.agentId, 'probe')).toEqual({ marker: 'from-subagent' })
	}).pipe(Effect.scoped),
)
