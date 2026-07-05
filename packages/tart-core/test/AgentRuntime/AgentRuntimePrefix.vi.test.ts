import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { AgentRuntime } from '../../src/index'
import { makeScriptedLanguageModel, textTurn } from '../TestLayers/ScriptedLanguageModel'
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { agentRuntimeBaseLayer, runInput, startInput } from './AgentRuntimeTestHelpers'

it.effect('keeps the second request prompt a byte-stable extension of the first', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const scripted = yield* makeScriptedLanguageModel([textTurn('One'), textTurn('Two')])
		const layer = agentRuntimeBaseLayer(scripted.layer, layerEchoTool(recorder))

		yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			yield* runtime.start(startInput())
			yield* runtime.run(runInput('first question'))
			yield* runtime.run(runInput('second question'))
		}).pipe(Effect.provide(layer))

		const prompts = yield* scripted.prompts
		expect(prompts).toHaveLength(2)

		const first = prompts[0]
		const second = prompts[1]
		if (first === undefined || second === undefined) throw new Error('expected two captured prompts')

		// The prompt-cache law: the second request begins with exactly the first request's messages.
		expect(second.content.length).toBeGreaterThan(first.content.length)
		expect(JSON.stringify(second.content.slice(0, first.content.length))).toBe(JSON.stringify(first.content))
	}),
)
