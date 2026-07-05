import { Layer } from 'effect'
import type { LanguageModel, Tool } from 'effect/unstable/ai'

import {
	AgentId,
	layerMemory,
	liveAgentRuntimeLayer,
	liveToolRuntimeLayer,
	makeHookRunner,
	noopToolEventSink,
	ToolEventSink,
	toolsetLayerFromToolkit,
	type ActiveModel,
	type HookConfig,
	type RunAgentInput,
	type StartAgentInput,
} from '../../src/index'
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime'
import { TestToolkit } from '../TestLayers/TestTools'

type TestToolHandlers = Tool.HandlersFor<typeof TestToolkit.tools>

export const agentId = AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa')

export const testModel: ActiveModel = {
	providerId: 'scripted',
	providerKind: 'openai-compatible',
	modelId: 'scripted-model',
	role: null,
	reasoningLevel: 'off',
}

export const startInput = (overrides?: Partial<StartAgentInput>): StartAgentInput => ({
	agentId,
	parentAgentId: null,
	toolCallId: null,
	model: testModel,
	systemPrompt: 'You are a test agent.',
	...overrides,
})

export const runInput = (text: string): RunAgentInput => ({
	agentId,
	parentAgentId: null,
	toolCallId: null,
	text,
})

/**
 * Real AgentRuntime over real ToolRuntime, EventLog, projections, and the live HookRunner
 * interpreter. Only true externals vary per test: the scripted model layer, the tool handler
 * bodies, and optional hook configuration.
 */
export const agentRuntimeBaseLayer = (
	modelLayer: Layer.Layer<LanguageModel.LanguageModel>,
	toolHandlerLayer: Layer.Layer<TestToolHandlers>,
	hooks: HookConfig = {},
) => {
	const memoryLayer = layerMemory
	const idsLayer = layerDeterministicRuntime({ startMillis: 1_000, stepMillis: 0 })
	const hookDeps = Layer.mergeAll(memoryLayer, idsLayer)

	const sharedLayer = Layer.mergeAll(
		memoryLayer,
		idsLayer,
		toolsetLayerFromToolkit(TestToolkit).pipe(Layer.provide(toolHandlerLayer)),
		makeHookRunner(hooks).pipe(Layer.provide(hookDeps)),
		Layer.succeed(ToolEventSink, noopToolEventSink),
	)

	const toolRuntimeLayer = liveToolRuntimeLayer.pipe(Layer.provideMerge(sharedLayer))

	return liveAgentRuntimeLayer.pipe(Layer.provideMerge(Layer.mergeAll(toolRuntimeLayer, modelLayer)))
}
