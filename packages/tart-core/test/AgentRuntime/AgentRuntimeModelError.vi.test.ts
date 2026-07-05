import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { AgentRuntime, type ErrorLogEntry } from '../../src/index'
import { failureTurn, makeScriptedLanguageModel } from '../TestLayers/ScriptedLanguageModel'
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { collectEntries } from '../ToolRuntime/ToolRuntimeTestHelpers'
import { agentRuntimeBaseLayer, runInput, startInput } from './AgentRuntimeTestHelpers'

it.effect('records a model provider failure as durable facts and resolves the run', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const scripted = yield* makeScriptedLanguageModel([failureTurn('boom: provider unavailable')])
		const layer = agentRuntimeBaseLayer(scripted.layer, layerEchoTool(recorder))

		const result = yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			yield* runtime.start(startInput({ systemPrompt: null }))
			const finished = yield* runtime.run(runInput('hi there'))
			const entries = yield* collectEntries

			return { finished, entries }
		}).pipe(Effect.provide(layer))

		expect(result.finished.outcome).toBe('error')
		expect(result.finished.reason).toContain('boom: provider unavailable')

		expect(result.entries.map((entry) => entry._tag)).toEqual([
			'agent_started',
			'user-message',
			'error',
			'agent-finished',
		])

		const error = result.entries.find((entry): entry is ErrorLogEntry => entry._tag === 'error')
		expect(error?.errorType).toBe('model')
		expect(error?.message).toContain('boom: provider unavailable')
	}),
)
