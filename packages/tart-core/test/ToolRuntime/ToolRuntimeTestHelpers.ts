import { Effect, Layer, Ref, Stream } from 'effect'
import { Prompt } from 'effect/unstable/ai'
import type { Tool } from 'effect/unstable/ai'

import {
	AgentId,
	EventLog,
	HookRunner,
	layerMemory,
	liveToolRuntimeLayer,
	noopToolEventSink,
	ToolCallId,
	ToolEventSink,
	toolsetLayerFromToolkit,
	type LogEntry,
	type ToolRuntimeEvent,
} from '../../src/index'
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime'
import { TestToolkit } from '../TestLayers/TestTools'

type TestToolHandlers = Tool.HandlersFor<typeof TestToolkit.tools>

export const agentId = AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
export const toolCallId = ToolCallId.make('tool_call_aaaaaaaaaaaaaaaaaaaaaaaa')

export const makeAssistantToolCall = (params: unknown = { text: 'hi' }): Prompt.AssistantMessage =>
	Prompt.assistantMessage({
		content: [
			Prompt.toolCallPart({
				id: toolCallId,
				name: 'echo',
				params,
				providerExecuted: false,
			}),
		],
	})

export const collectEntries: Effect.Effect<ReadonlyArray<LogEntry>, never, EventLog> = Effect.gen(function* () {
	const eventLog = yield* EventLog

	return yield* Stream.runCollect(eventLog.entries()).pipe(
		Effect.orDie,
		Effect.map((entries): ReadonlyArray<LogEntry> => entries),
	)
})

export const layerRecordingToolEvents = (
	eventsRef: Ref.Ref<ReadonlyArray<ToolRuntimeEvent>>,
): Layer.Layer<ToolEventSink> =>
	Layer.succeed(ToolEventSink, {
		emit: (event) => Ref.update(eventsRef, (events) => [...events, event]),
	})

export const layerNoopToolEvents: Layer.Layer<ToolEventSink> = Layer.succeed(ToolEventSink, noopToolEventSink)

export const toolRuntimeBaseLayer = (
	hookLayer: Layer.Layer<HookRunner>,
	toolHandlerLayer: Layer.Layer<TestToolHandlers>,
	eventLayer: Layer.Layer<ToolEventSink> = layerNoopToolEvents,
) =>
	liveToolRuntimeLayer.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				layerMemory,
				layerDeterministicRuntime({ startMillis: 1_000, stepMillis: 0 }),
				toolsetLayerFromToolkit(TestToolkit).pipe(Layer.provide(toolHandlerLayer)),
				hookLayer,
				eventLayer,
			),
		),
	)
