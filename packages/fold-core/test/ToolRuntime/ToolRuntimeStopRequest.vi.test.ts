import { describe, expect, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'

import { makeHookRunner, StopController, ToolRuntime } from '../../src/index'
import { hookRunnerNoop } from '../TestLayers/NoOpHookRunner'
import { layerEchoTool, layerStoppingEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { agentId, makeAssistantToolCall, toolRuntimeBaseLayer } from './ToolRuntimeTestHelpers'

describe('ToolRuntime cooperative stop requests', () => {
	it.effect('a tool handler can request a stop; the result is still persisted and settle reports it', () =>
		Effect.gen(function* () {
			const recorder = yield* makeEchoRecorder()
			const layer = toolRuntimeBaseLayer(hookRunnerNoop, layerStoppingEchoTool(recorder))

			const result = yield* Effect.gen(function* () {
				const runtime = yield* ToolRuntime

				const settlement = yield* runtime.settle({
					agentId,
					parentAgentId: null,
					assistantMessage: makeAssistantToolCall({ text: 'wrap it up' }),
				})

				const calls = yield* Ref.get(recorder.calls)

				return { settlement, calls }
			}).pipe(Effect.provide(layer))

			expect(result.calls).toEqual(['wrap it up'])
			expect(result.settlement.stopRequested).toBe(true)
			expect(result.settlement.toolResults[0]?.message.content[0]).toMatchObject({
				type: 'tool-result',
				name: 'echo',
				isFailure: false,
				result: { echoed: 'wrap it up' },
			})
		}),
	)

	it.effect('a preToolUse hook can request a stop while continuing; the tool still executes', () =>
		Effect.gen(function* () {
			const recorder = yield* makeEchoRecorder()
			const hookLayer = makeHookRunner({
				preToolUse: [
					{
						name: 'stop-after-this-batch',
						tools: ['echo'],
						handler: ({ params }) =>
							Effect.gen(function* () {
								const stop = yield* StopController
								yield* stop.requestStop('hook asked to stop')

								return { _tag: 'continue' as const, params }
							}),
					},
				],
			})
			const layer = toolRuntimeBaseLayer(hookLayer, layerEchoTool(recorder))

			const result = yield* Effect.gen(function* () {
				const runtime = yield* ToolRuntime

				const settlement = yield* runtime.settle({
					agentId,
					parentAgentId: null,
					assistantMessage: makeAssistantToolCall({ text: 'hi' }),
				})

				const calls = yield* Ref.get(recorder.calls)

				return { settlement, calls }
			}).pipe(Effect.provide(layer))

			expect(result.calls).toEqual(['hi'])
			expect(result.settlement.stopRequested).toBe(true)
			expect(result.settlement.toolResults).toHaveLength(1)
		}),
	)
})
