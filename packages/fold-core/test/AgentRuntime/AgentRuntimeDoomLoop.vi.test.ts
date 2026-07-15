import { expect, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'

import { AgentRuntime } from '../../src/index'
import { makeScriptedLanguageModel, textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { collectEntries } from '../ToolRuntime/ToolRuntimeTestHelpers'
import { agentRuntimeBaseLayer, runInput, startInput } from './AgentRuntimeTestHelpers'

it.effect('stops gracefully after repeated identical tool-call batches', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const scripted = yield* makeScriptedLanguageModel([
			toolCallTurn([{ id: 'provider-call-1', name: 'echo', params: { text: 'loop' } }]),
			toolCallTurn([{ id: 'provider-call-2', name: 'echo', params: { text: 'loop' } }]),
			toolCallTurn([{ id: 'provider-call-3', name: 'echo', params: { text: 'loop' } }]),
			textTurn('should not be reached'),
		])
		const layer = agentRuntimeBaseLayer(
			scripted.layer,
			layerEchoTool(recorder),
			{},
			{
				doomLoop: { enabled: true, repeatedToolCalls: 3 },
			},
		)

		const result = yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			yield* runtime.start(startInput())
			const finished = yield* runtime.run(runInput('use the echo tool'))
			const entries = yield* collectEntries
			const calls = yield* Ref.get(recorder.calls)
			const prompts = yield* scripted.prompts

			return { finished, entries, calls, prompts }
		}).pipe(Effect.provide(layer))

		expect(result.finished.outcome).toBe('stopped')
		expect(result.finished.reason).toContain('doom loop detected')
		expect(result.calls).toEqual(['loop', 'loop', 'loop'])
		expect(result.prompts).toHaveLength(3)
		expect(result.entries.map((entry) => entry._tag)).toEqual([
			'agent_started',
			'system-message',
			'user-message',
			'assistant-message',
			'tool-result',
			'assistant-message',
			'tool-result',
			'assistant-message',
			'tool-result',
			'agent-finished',
		])
	}),
)
