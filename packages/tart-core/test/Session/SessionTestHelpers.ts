import { Layer } from 'effect'
import type { LanguageModel, Tool } from 'effect/unstable/ai'

import {
	layerDefaultSystemPrompt,
	layerInMemoryEventLog,
	liveAgentEventsLayer,
	liveAgentRuntimeLayer,
	liveModelRequestSettingsLayer,
	liveSessionLayer,
	liveToolRuntimeLayer,
	makeHookRunner,
	makeSessionControls,
	makeToolsetResolver,
	SessionControls,
	Subagents,
	toolEventSinkLayerFromAgentEvents,
	toolsetLayerFromToolkit,
	type HookConfig,
	type StartSessionInput,
} from '../../src/index'
import { noSubagentsStub, testModel } from '../AgentRuntime/AgentRuntimeTestHelpers'
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime'
import { TestToolkit } from '../TestLayers/TestTools'

type TestToolHandlers = Tool.HandlersFor<typeof TestToolkit.tools>

export { testModel }

export const startSessionInput = (overrides?: Partial<StartSessionInput>): StartSessionInput => ({
	cwd: '/test',
	model: testModel,
	systemPrompt: 'You are a test agent.',
	...overrides,
})

/**
 * Real Session over the real AgentRuntime, ToolRuntime, EventLog, projections, live HookRunner, and live
 * AgentEvents. Mirrors `agentRuntimeBaseLayer` sharing discipline: one `layerInMemoryEventLog` reference,
 * one `layerDeterministicRuntime` reference, and one `liveAgentEventsLayer` reference are shared across the
 * whole graph so Effect layer memoization builds a single EventLog, clock/ids, and AgentEvents PubSub.
 *
 * Two differences from `agentRuntimeBaseLayer`: `ToolEventSink` is bridged into AgentEvents (so tool
 * progress reaches `Session.events`), and `liveSessionLayer` is merged on top so tests can reach `Session`,
 * `EventLog`, and `AgentEvents`.
 */
export const sessionBaseLayer = (
	modelLayer: Layer.Layer<LanguageModel.LanguageModel>,
	toolHandlerLayer: Layer.Layer<TestToolHandlers>,
	hooks: HookConfig = {},
) => {
	const memoryLayer = layerInMemoryEventLog
	const idsLayer = layerDeterministicRuntime({ startMillis: 1_000, stepMillis: 0 })
	const agentEventsLayer = liveAgentEventsLayer
	const hookDeps = Layer.mergeAll(memoryLayer, idsLayer)
	const toolsetLayer = toolsetLayerFromToolkit(TestToolkit).pipe(Layer.provide(toolHandlerLayer))

	const sharedLayer = Layer.mergeAll(
		memoryLayer,
		idsLayer,
		agentEventsLayer,
		toolsetLayer,
		makeToolsetResolver().pipe(Layer.provide(toolsetLayer)),
		layerDefaultSystemPrompt,
		liveModelRequestSettingsLayer,
		makeHookRunner(hooks).pipe(Layer.provide(hookDeps)),
		toolEventSinkLayerFromAgentEvents.pipe(Layer.provide(agentEventsLayer)),
		Layer.succeed(Subagents, noSubagentsStub),
		Layer.effect(SessionControls, makeSessionControls()),
	)

	const toolRuntimeLayer = liveToolRuntimeLayer.pipe(Layer.provideMerge(sharedLayer))

	const agentRuntimeLayer = liveAgentRuntimeLayer.pipe(
		Layer.provideMerge(Layer.mergeAll(toolRuntimeLayer, modelLayer)),
	)

	return liveSessionLayer.pipe(Layer.provideMerge(agentRuntimeLayer))
}
