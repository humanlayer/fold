import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { AgentRuntime, type AssistantMessageLogEntry } from '../../src/index'
import { makeScriptedLanguageModel, textTurn } from '../TestLayers/ScriptedLanguageModel'
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { collectEntries } from '../ToolRuntime/ToolRuntimeTestHelpers'
import { agentRuntimeBaseLayer, runInput, startInput } from './AgentRuntimeTestHelpers'

it.effect('completes a text-only run with the full log shape', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const scripted = yield* makeScriptedLanguageModel([textTurn('Hello!')])
		const layer = agentRuntimeBaseLayer(scripted.layer, layerEchoTool(recorder))

		const result = yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			const started = yield* runtime.start(startInput())
			const finished = yield* runtime.run(runInput('hi there'))
			const entries = yield* collectEntries

			return { started, finished, entries }
		}).pipe(Effect.provide(layer))

		expect(result.started._tag).toBe('agent_started')
		expect(result.started.tools).toEqual(['echo'])

		expect(result.finished.outcome).toBe('completed')
		expect(result.finished.resultText).toBe('Hello!')

		expect(result.entries.map((entry) => entry._tag)).toEqual([
			'agent_started',
			'system-message',
			'user-message',
			'assistant-message',
			'agent-finished',
		])

		const assistant = result.entries.find(
			(entry): entry is AssistantMessageLogEntry => entry._tag === 'assistant-message',
		)
		expect(assistant?.finish?.reason).toBe('stop')
		expect(assistant?.finish?.usage.inputTokens.total).toBe(10)
		expect(assistant?.finish?.usage.outputTokens.total).toBe(5)

		expect(yield* scripted.remainingTurns).toBe(0)
	}),
)
