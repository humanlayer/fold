import { expect, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'

import { ToolRuntime } from '../../src/index'
import { hookRunnerNoop } from '../TestLayers/NoOpHookRunner'
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { agentId, collectEntries, makeAssistantToolCall, toolRuntimeBaseLayer } from './ToolRuntimeTestHelpers'

it.effect('settles a real tool call with NoOpHookRunner', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const layer = toolRuntimeBaseLayer(hookRunnerNoop, layerEchoTool(recorder))

		const result = yield* Effect.gen(function* () {
			const runtime = yield* ToolRuntime

			const settlement = yield* runtime.settle({
				agentId,
				parentAgentId: null,
				assistantMessage: makeAssistantToolCall({ text: 'hi' }),
			})

			const entries = yield* collectEntries
			const calls = yield* Ref.get(recorder.calls)

			return { settlement, entries, calls }
		}).pipe(Effect.provide(layer))

		expect(result.calls).toEqual(['hi'])
		expect(result.settlement.stopRequested).toBe(false)
		expect(result.settlement.toolResults).toHaveLength(1)
		expect(result.entries.map((entry) => entry._tag)).toEqual(['tool-result'])

		const toolResult = result.settlement.toolResults[0]
		expect(toolResult).toBeDefined()
		expect(toolResult?.message.content[0]).toMatchObject({
			type: 'tool-result',
			id: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
			name: 'echo',
			isFailure: false,
			result: { echoed: 'hi' },
		})
		expect(toolResult?.executedInput).toBeUndefined()
	}),
)
