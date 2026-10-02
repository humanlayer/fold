import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Layer } from 'effect'
import type { LanguageModel, Tool } from 'effect/unstable/ai'

import {
	AgentId,
	layerDefaultSystemPrompt,
	layerInMemoryEventLog,
	liveAgentEventsLayer,
	liveAgentRuntimeLayer,
	liveModelRequestSettingsLayer,
	liveToolRuntimeLayer,
	layerHookRunner,
	layerSessionControls,
	layerToolsetResolver,
	noopToolEventSink,
	StopConditions,
	ToolEventSink,
	toolsetLayerFromToolkit,
	type ActiveModel,
	type HookConfig,
	type RunAgentInput,
	type StartAgentInput,
	type StopConditionConfig,
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
	requestedReasoningLevel: 'off',
	reasoning: { _tag: 'disabled' },
}

export const startInput = (overrides?: Partial<StartAgentInput>): StartAgentInput => ({
	agentId,
	parentAgentId: null,
	toolCallId: null,
	mode: 'fresh',
	fork: null,
	skill: null,
	agentType: null,
	model: testModel,
	systemPrompt: ['You are a test agent.'],
	...overrides,
})

export const runInput = (text: string): RunAgentInput => ({
	agentId,
	parentAgentId: null,
	toolCallId: null,
	messages: [text],
})

/** Die-on-use Subagents stub: the runtime harness tests exercise no subagent dispatches. */
/**
 * Real AgentRuntime over real ToolRuntime, EventLog, projections, and the live HookRunner
 * interpreter. Only true externals vary per test: the scripted model layer, the tool handler
 * bodies, and optional hook configuration.
 */
export const agentRuntimeBaseLayer = (
	modelLayer: Layer.Layer<LanguageModel.LanguageModel>,
	toolHandlerLayer: Layer.Layer<TestToolHandlers>,
	hooks: HookConfig = {},
	stopConditions: StopConditionConfig = {},
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
		layerToolsetResolver().pipe(Layer.provide(toolsetLayer)),
		layerDefaultSystemPrompt,
		liveModelRequestSettingsLayer,
		layerHookRunner(hooks).pipe(Layer.provide(hookDeps)),
		Layer.succeed(ToolEventSink, noopToolEventSink),
		Layer.succeed(StopConditions, stopConditions),
		layerSessionControls(),
		NodeFileSystem.layer,
	)

	const toolRuntimeLayer = liveToolRuntimeLayer.pipe(Layer.provideMerge(sharedLayer))

	return liveAgentRuntimeLayer.pipe(Layer.provideMerge(Layer.mergeAll(toolRuntimeLayer, modelLayer)))
}
