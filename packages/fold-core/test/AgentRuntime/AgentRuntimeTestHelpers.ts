import { Effect, Layer } from 'effect'
import type { LanguageModel, Tool } from 'effect/unstable/ai'

import {
	AgentId,
	layerDefaultSystemPrompt,
	layerInMemoryEventLog,
	liveAgentEventsLayer,
	liveAgentRuntimeLayer,
	liveModelRequestSettingsLayer,
	liveToolRuntimeLayer,
	makeHookRunner,
	makeSessionControls,
	makeToolsetResolver,
	noopToolEventSink,
	SessionControls,
	StopConditions,
	Subagents,
	ToolEventSink,
	toolsetLayerFromToolkit,
	type ActiveModel,
	type HookConfig,
	type RunAgentInput,
	type StartAgentInput,
	type StopConditionConfig,
	type SubagentsService,
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
	systemPrompt: 'You are a test agent.',
	...overrides,
})

export const runInput = (text: string): RunAgentInput => ({
	agentId,
	parentAgentId: null,
	toolCallId: null,
	messages: [text],
})

/** Die-on-use Subagents stub: the runtime harness tests exercise no subagent dispatches. */
export const noSubagentsStub: SubagentsService = {
	dispatch: () => Effect.die(new Error('Subagents.dispatch not available in this test harness')),
	fork: () => Effect.die(new Error('Subagents.fork not available in this test harness')),
	resume: () => Effect.die(new Error('Subagents.resume not available in this test harness')),
	continueSubagent: () => Effect.die(new Error('Subagents.continueSubagent not available in this test harness')),
}

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
		makeToolsetResolver().pipe(Layer.provide(toolsetLayer)),
		layerDefaultSystemPrompt,
		liveModelRequestSettingsLayer,
		makeHookRunner(hooks).pipe(Layer.provide(hookDeps)),
		Layer.succeed(ToolEventSink, noopToolEventSink),
		Layer.succeed(Subagents, noSubagentsStub),
		Layer.succeed(StopConditions, stopConditions),
		Layer.effect(SessionControls, makeSessionControls()),
	)

	const toolRuntimeLayer = liveToolRuntimeLayer.pipe(Layer.provideMerge(sharedLayer))

	return liveAgentRuntimeLayer.pipe(Layer.provideMerge(Layer.mergeAll(toolRuntimeLayer, modelLayer)))
}
