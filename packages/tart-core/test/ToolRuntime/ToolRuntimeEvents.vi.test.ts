import { expect, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'

import { ToolRuntime, type ToolRuntimeEvent } from '../../src/index'
import { hookRunnerNoop } from '../TestLayers/NoOpHookRunner'
import { layerEventfulEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import {
	agentId,
	layerRecordingToolEvents,
	makeAssistantToolCall,
	toolRuntimeBaseLayer,
} from './ToolRuntimeTestHelpers'

it.effect('tool handler can emit UI progress events separate from final result', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const eventsRef = yield* Ref.make<ReadonlyArray<ToolRuntimeEvent>>([])
		const layer = toolRuntimeBaseLayer(
			hookRunnerNoop,
			layerEventfulEchoTool(recorder),
			layerRecordingToolEvents(eventsRef),
		)

		const result = yield* Effect.gen(function* () {
			const runtime = yield* ToolRuntime

			const settlement = yield* runtime.settle({
				agentId,
				parentAgentId: null,
				assistantMessage: makeAssistantToolCall({ text: 'event-value' }),
			})

			const events = yield* Ref.get(eventsRef)

			return { settlement, events }
		}).pipe(Effect.provide(layer))

		expect(result.events).toHaveLength(1)
		expect(result.events[0]).toMatchObject({
			agentId,
			toolName: 'echo',
			payload: { progress: 'working:event-value' },
		})

		expect(result.settlement.toolResults[0]?.message.content[0]).toMatchObject({
			type: 'tool-result',
			result: { echoed: 'event-value' },
		})
	}),
)
