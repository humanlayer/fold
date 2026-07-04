import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Schema } from 'effect'
import { Prompt, Tool, Toolkit } from 'effect/unstable/ai'

import { layerMemory, liveToolRuntimeLayer, ToolRuntime, toolsetLayerFromToolkit } from '../../src/index'
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime'
import { hookRunnerNoop } from '../TestLayers/NoOpHookRunner'
import { agentId, collectEntries, layerNoopToolEvents, toolCallId } from './ToolRuntimeTestHelpers'

const BlockingTool = Tool.make('block', {
	description: 'Blocks until the test releases it.',
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.Struct({ done: Schema.String }),
	failure: Schema.Struct({ message: Schema.String }),
	failureMode: 'return',
})

const BlockingToolkit = Toolkit.make(BlockingTool)

const makeBlockAssistantMessage = (): Prompt.AssistantMessage =>
	Prompt.assistantMessage({
		content: [
			Prompt.toolCallPart({
				id: toolCallId,
				name: 'block',
				params: { text: 'wait' },
				providerExecuted: false,
			}),
		],
	})

it.effect('writes a synthetic interrupted tool-result when a running tool fiber is interrupted', () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const release = yield* Deferred.make<void>()
		const handlerLayer = BlockingToolkit.toLayer(
			BlockingToolkit.of({
				block: ({ text }) =>
					Effect.gen(function* () {
						yield* Deferred.succeed(started, undefined)
						yield* Deferred.await(release)

						return { done: text }
					}),
			}),
		)
		const layer = liveToolRuntimeLayer.pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					layerMemory,
					layerDeterministicRuntime({ startMillis: 1_000, stepMillis: 0 }),
					toolsetLayerFromToolkit(BlockingToolkit).pipe(Layer.provide(handlerLayer)),
					hookRunnerNoop,
					layerNoopToolEvents,
				),
			),
		)

		const entries = yield* Effect.gen(function* () {
			const runtime = yield* ToolRuntime
			const fiber = yield* runtime
				.settle({
					agentId,
					parentAgentId: null,
					assistantMessage: makeBlockAssistantMessage(),
				})
				.pipe(Effect.forkChild)

			yield* Deferred.await(started)
			yield* Fiber.interrupt(fiber)

			return yield* collectEntries
		}).pipe(Effect.provide(layer))

		expect(entries.map((entry) => entry._tag)).toEqual(['tool-result'])

		const toolResult = entries[0]
		expect(toolResult?._tag).toBe('tool-result')
		if (toolResult?._tag !== 'tool-result') return

		expect(toolResult.message.content[0]).toMatchObject({
			type: 'tool-result',
			id: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
			name: 'block',
			isFailure: true,
			result: '<system-information>The user interrupted the execution of this tool call.</system-information>',
		})
	}),
)
