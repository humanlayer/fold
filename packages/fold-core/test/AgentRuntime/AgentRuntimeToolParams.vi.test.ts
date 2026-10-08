import { expect, it } from '@effect/vitest'
import { Predicate, Effect, Ref } from 'effect'
import { Tool } from 'effect/ai'

import { AgentRuntime, type ToolResultLogEntry } from '../../src/index'
import { makeScriptedLanguageModel, textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { collectEntries } from '../ToolRuntime/ToolRuntimeTestHelpers'
import { agentRuntimeBaseLayer, runInput, startInput } from './AgentRuntimeTestHelpers'

it.effect('returns a tool call with bad params to the model as a failed tool result', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder
		const scripted = yield* makeScriptedLanguageModel([
			toolCallTurn([{ id: 'provider-call-1', name: 'echo', params: { txet: 'hi' } }]),
			textTurn('Fixed my call'),
		])
		const layer = agentRuntimeBaseLayer(scripted.layer, layerEchoTool(recorder))

		const result = yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			yield* runtime.start(startInput())
			const finished = yield* runtime.run(runInput('use the echo tool'))
			const entries = yield* collectEntries
			const calls = yield* Ref.get(recorder.calls)

			return { finished, entries, calls }
		}).pipe(Effect.provide(layer))

		expect(result.calls).toEqual([])
		expect(result.finished.outcome).toBe('completed')
		expect(result.finished.resultText).toBe('Fixed my call')

		const toolResult = result.entries.find((entry): entry is ToolResultLogEntry =>
			Predicate.isTagged(entry, 'tool-result'),
		)
		const part = toolResult?.message.content.find((content) => content.type === 'tool-result')
		expect(part).toMatchObject({
			isFailure: true,
			result: { reason: { _tag: 'ToolParameterValidationError', description: 'Missing key\n  at ["text"]' } },
		})

		// The model is still offered the tool's real params schema.
		const requests = yield* scripted.requests
		const echo = requests[0]?.tools.find((tool) => tool.name === 'echo')
		if (echo === undefined) throw new Error('expected the echo tool on the first request')
		expect(Tool.getJsonSchema(echo)).toMatchObject({ properties: { text: { type: 'string' } }, required: ['text'] })
	}),
)
