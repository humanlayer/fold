import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { toolStateForAgent, ToolRuntime } from '../../src/index'
import { hookRunnerNoop } from '../TestLayers/NoOpHookRunner'
import { layerStatefulEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { agentId, collectEntries, makeAssistantToolCall, toolRuntimeBaseLayer } from './ToolRuntimeTestHelpers'

it.effect('tool handler can write durable ToolState', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const layer = toolRuntimeBaseLayer(hookRunnerNoop, layerStatefulEchoTool(recorder))

		const result = yield* Effect.gen(function* () {
			const runtime = yield* ToolRuntime

			yield* runtime.settle({
				agentId,
				parentAgentId: null,
				assistantMessage: makeAssistantToolCall({ text: 'state-value' }),
			})

			const entries = yield* collectEntries

			return {
				entries,
				state: toolStateForAgent(entries, agentId, 'echo'),
			}
		}).pipe(Effect.provide(layer))

		expect(result.entries.map((entry) => entry._tag)).toEqual(['tool_state', 'tool-result'])
		expect(result.state).toEqual({ last: 'state-value' })
	}),
)
