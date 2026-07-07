import { expect, it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'
import type { LanguageModel } from 'effect/unstable/ai'

import {
	AgentRuntime,
	EventLog,
	layerDefaultSystemPrompt,
	layerInMemoryEventLog,
	liveAgentEventsLayer,
	liveAgentRuntimeLayer,
	liveModelRequestSettingsLayer,
	liveToolRuntimeLayer,
	makeHookRunner,
	makeSystemPrompt,
	makeToolsetResolver,
	noopToolEventSink,
	SystemPrompt,
	ToolEventSink,
	toolsetLayerFromToolkit,
	type ActiveModel,
	type SystemMessageLogEntry,
} from '../../src/index'
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime'
import { makeScriptedLanguageModel, textTurn, type ScriptedRequest } from '../TestLayers/ScriptedLanguageModel'
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { collectEntries } from '../ToolRuntime/ToolRuntimeTestHelpers'
import { agentId, agentRuntimeBaseLayer, runInput, startInput, testModel } from './AgentRuntimeTestHelpers'

const openAiMediumModel: ActiveModel = {
	providerId: 'openai',
	providerKind: 'openai-compatible',
	modelId: 'gpt-5.5',
	role: null,
	requestedReasoningLevel: 'medium',
	reasoning: { _tag: 'effort', effort: 'medium' },
}

it.effect('applies the projected reasoning to requests and rebinds after a thinking-change', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const scripted = yield* makeScriptedLanguageModel([textTurn('one'), textTurn('two')])
		const layer = agentRuntimeBaseLayer(scripted.layer, layerEchoTool(recorder))

		yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime
			const eventLog = yield* EventLog

			yield* runtime.start(startInput({ model: openAiMediumModel }))
			yield* runtime.run(runInput('first'))

			yield* eventLog.append({
				_tag: 'thinking-change',
				agentId,
				parentAgentId: null,
				toolCallId: null,
				reasoningLevel: 'high',
				reason: 'test raises reasoning',
			})

			yield* runtime.run(runInput('second'))
		}).pipe(Effect.provide(layer))

		const requests = yield* scripted.requests
		expect(requests).toHaveLength(2)
		expect(requests[0]?.openAiConfig).toEqual({ model: 'gpt-5.5', reasoning: { effort: 'medium' } })
		expect(requests[0]?.toolNames).toEqual(['echo'])
		expect(requests[1]?.openAiConfig?.reasoning).toEqual({ effort: 'high' })
	}),
)

it.effect('binds the model but sends no reasoning config when the active level is off', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const scripted = yield* makeScriptedLanguageModel([textTurn('one')])
		const layer = agentRuntimeBaseLayer(scripted.layer, layerEchoTool(recorder))

		yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			yield* runtime.start(startInput({ model: testModel }))
			yield* runtime.run(runInput('hello'))
		}).pipe(Effect.provide(layer))

		const requests = yield* scripted.requests
		expect(requests[0]?.openAiConfig).toEqual({ model: 'scripted-model' })
	}),
)

it.effect('a tools-change entry rebinds the advertised toolkit on the next request', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const scripted = yield* makeScriptedLanguageModel([textTurn('one'), textTurn('two')])
		const layer = agentRuntimeBaseLayer(scripted.layer, layerEchoTool(recorder))

		yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime
			const eventLog = yield* EventLog

			yield* runtime.start(startInput())
			yield* runtime.run(runInput('first'))

			yield* eventLog.append({
				_tag: 'tools-change',
				agentId,
				parentAgentId: null,
				toolCallId: null,
				tools: [],
				reason: 'test removes all tools',
			})

			yield* runtime.run(runInput('second'))
		}).pipe(Effect.provide(layer))

		const requests = yield* scripted.requests
		expect(requests[0]?.toolNames).toEqual(['echo'])
		expect(requests[1]?.toolNames).toEqual([])
	}),
)

// ── Per-family prompt/toolset selection end to end ──────────────────────────
// A toolkit installing write/edit/apply_patch plus family base prompts proves the D17 epoch behavior:
// each family starts with its own base prompt and toolset (claude sees write/edit; gpt and codex see
// apply_patch), and `AgentRuntime.switchModel` - the D17 choreography of model-change + recomposed
// leading system-message + tools-change - rebinds prompt, tools, and provider request config on the
// very next request.

const WriteTool = Tool.make('write', {
	description: 'Test write tool.',
	parameters: Schema.Struct({ path: Schema.String }),
	success: Schema.String,
	failure: Schema.Struct({ message: Schema.String }),
	failureMode: 'return',
})

const EditTool = Tool.make('edit', {
	description: 'Test edit tool.',
	parameters: Schema.Struct({ path: Schema.String }),
	success: Schema.String,
	failure: Schema.Struct({ message: Schema.String }),
	failureMode: 'return',
})

const ApplyPatchTool = Tool.make('apply_patch', {
	description: 'Test apply_patch tool.',
	parameters: Schema.Struct({ patch_text: Schema.String }),
	success: Schema.String,
	failure: Schema.Struct({ message: Schema.String }),
	failureMode: 'return',
})

const FamilyToolkit = Toolkit.make(WriteTool, EditTool, ApplyPatchTool)

const familyToolkitLayer = FamilyToolkit.toLayer(
	FamilyToolkit.of({
		write: () => Effect.succeed('ok'),
		edit: () => Effect.succeed('ok'),
		apply_patch: () => Effect.succeed('ok'),
	}),
)

const familyBasePrompts = makeSystemPrompt({
	basePrompts: {
		gpt: 'GPT BASE PROMPT',
		claude: 'CLAUDE BASE PROMPT',
		codex: 'CODEX BASE PROMPT',
	},
})

/** agentRuntimeBaseLayer clone over the family toolkit, with a configurable SystemPrompt layer. */
const familyAgentLayer = (
	modelLayer: Layer.Layer<LanguageModel.LanguageModel>,
	systemPromptLayer: Layer.Layer<SystemPrompt> = layerDefaultSystemPrompt,
) => {
	const memoryLayer = layerInMemoryEventLog
	const idsLayer = layerDeterministicRuntime({ startMillis: 1_000, stepMillis: 0 })
	const toolsetLayer = toolsetLayerFromToolkit(FamilyToolkit).pipe(Layer.provide(familyToolkitLayer))

	const sharedLayer = Layer.mergeAll(
		memoryLayer,
		idsLayer,
		liveAgentEventsLayer,
		toolsetLayer,
		makeToolsetResolver().pipe(Layer.provide(toolsetLayer)),
		systemPromptLayer,
		liveModelRequestSettingsLayer,
		makeHookRunner({}).pipe(Layer.provide(Layer.mergeAll(memoryLayer, idsLayer))),
		Layer.succeed(ToolEventSink, noopToolEventSink),
	)

	const toolRuntimeLayer = liveToolRuntimeLayer.pipe(Layer.provideMerge(sharedLayer))

	return liveAgentRuntimeLayer.pipe(Layer.provideMerge(Layer.mergeAll(toolRuntimeLayer, modelLayer)))
}

const codexModel: ActiveModel = {
	providerId: 'codex',
	providerKind: 'codex',
	modelId: 'gpt-5.5',
	role: null,
	requestedReasoningLevel: 'medium',
	reasoning: { _tag: 'effort', effort: 'medium', summary: 'auto' },
}

const claudeOffModel: ActiveModel = {
	providerId: 'anthropic',
	providerKind: 'anthropic',
	modelId: 'claude-opus-4-8',
	role: null,
	requestedReasoningLevel: 'off',
	thinking: { _tag: 'disabled' },
}

const claudeAdaptiveModel: ActiveModel = {
	providerId: 'anthropic',
	providerKind: 'anthropic',
	modelId: 'claude-opus-4-8',
	role: null,
	requestedReasoningLevel: 'medium',
	thinking: { _tag: 'adaptive' },
}

/** The system-role contents of one recorded request's prompt, in order. */
const systemContents = (request: ScriptedRequest | undefined): ReadonlyArray<string> =>
	request === undefined
		? []
		: request.prompt.content.flatMap((message) => (message.role === 'system' ? [message.content] : []))

it.effect('openai agents start with the gpt base prompt, apply_patch toolset, and openai request config', () =>
	Effect.gen(function* () {
		const scripted = yield* makeScriptedLanguageModel([textTurn('done')])
		const layer = familyAgentLayer(scripted.layer, familyBasePrompts)

		const result = yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			const started = yield* runtime.start(startInput({ model: openAiMediumModel, systemPrompt: 'agent rules' }))
			yield* runtime.run(runInput('go'))
			const entries = yield* collectEntries

			return { started, entries }
		}).pipe(Effect.provide(layer))

		expect(result.started.tools).toEqual(['apply_patch'])

		const leading = result.entries.find((entry): entry is SystemMessageLogEntry => entry._tag === 'system-message')
		expect(leading?.messages.map((message) => message.content)).toEqual(['GPT BASE PROMPT', 'agent rules'])

		const requests = yield* scripted.requests
		expect(systemContents(requests[0])).toEqual(['GPT BASE PROMPT', 'agent rules'])
		expect(requests[0]?.toolNames).toEqual(['apply_patch'])
		expect(requests[0]?.openAiConfig).toEqual({ model: 'gpt-5.5', reasoning: { effort: 'medium' } })
		expect(requests[0]?.anthropicConfig).toBeNull()
	}),
)

it.effect('anthropic agents start with the claude base prompt, write/edit toolset, and adaptive thinking', () =>
	Effect.gen(function* () {
		const scripted = yield* makeScriptedLanguageModel([textTurn('done')])
		const layer = familyAgentLayer(scripted.layer, familyBasePrompts)

		const result = yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			const started = yield* runtime.start(
				startInput({ model: claudeAdaptiveModel, systemPrompt: 'agent rules' }),
			)
			yield* runtime.run(runInput('go'))
			const entries = yield* collectEntries

			return { started, entries }
		}).pipe(Effect.provide(layer))

		expect(result.started.tools).toEqual(['write', 'edit'])

		const leading = result.entries.find((entry): entry is SystemMessageLogEntry => entry._tag === 'system-message')
		expect(leading?.messages.map((message) => message.content)).toEqual(['CLAUDE BASE PROMPT', 'agent rules'])

		const requests = yield* scripted.requests
		expect(systemContents(requests[0])).toEqual(['CLAUDE BASE PROMPT', 'agent rules'])
		expect(requests[0]?.toolNames).toEqual(['write', 'edit'])
		expect(requests[0]?.anthropicConfig).toEqual({
			thinking: { type: 'adaptive' },
			output_config: { effort: 'medium' },
		})
		expect(requests[0]?.openAiConfig).toBeNull()
	}),
)

it.effect('switchModel from openai to anthropic rebinds prompt, toolset, and provider config', () =>
	Effect.gen(function* () {
		const scripted = yield* makeScriptedLanguageModel([textTurn('one'), textTurn('two')])
		const layer = familyAgentLayer(scripted.layer, familyBasePrompts)

		const entries = yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			yield* runtime.start(startInput({ model: openAiMediumModel, systemPrompt: 'agent rules' }))
			yield* runtime.run(runInput('first'))

			yield* runtime.switchModel({
				agentId,
				parentAgentId: null,
				toolCallId: null,
				model: claudeAdaptiveModel,
				systemPrompt: 'agent rules',
				reason: 'test switches models',
			})

			yield* runtime.run(runInput('second'))

			return yield* collectEntries
		}).pipe(Effect.provide(layer))

		expect(entries.map((entry) => entry._tag)).toContain('model-change')
		expect(entries.map((entry) => entry._tag)).toContain('tools-change')

		const requests = yield* scripted.requests
		expect(requests).toHaveLength(2)

		expect(systemContents(requests[0])).toEqual(['GPT BASE PROMPT', 'agent rules'])
		expect(requests[0]?.toolNames).toEqual(['apply_patch'])
		expect(requests[0]?.openAiConfig).toEqual({ model: 'gpt-5.5', reasoning: { effort: 'medium' } })
		expect(requests[0]?.anthropicConfig).toBeNull()

		expect(systemContents(requests[1])).toEqual(['CLAUDE BASE PROMPT', 'agent rules'])
		expect(requests[1]?.toolNames).toEqual(['write', 'edit'])
		expect(requests[1]?.anthropicConfig).toEqual({
			thinking: { type: 'adaptive' },
			output_config: { effort: 'medium' },
		})
		expect(requests[1]?.openAiConfig).toBeNull()
	}),
)

it.effect('switchModel from anthropic to codex flips write/edit to apply_patch', () =>
	Effect.gen(function* () {
		const scripted = yield* makeScriptedLanguageModel([textTurn('one'), textTurn('two')])
		const layer = familyAgentLayer(scripted.layer, familyBasePrompts)

		yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			yield* runtime.start(startInput({ model: claudeAdaptiveModel, systemPrompt: 'agent rules' }))
			yield* runtime.run(runInput('first'))

			yield* runtime.switchModel({
				agentId,
				parentAgentId: null,
				toolCallId: null,
				model: codexModel,
				systemPrompt: 'agent rules',
				reason: 'test switches models',
			})

			yield* runtime.run(runInput('second'))
		}).pipe(Effect.provide(layer))

		const requests = yield* scripted.requests
		expect(requests[0]?.toolNames).toEqual(['write', 'edit'])

		expect(systemContents(requests[1])).toEqual(['CODEX BASE PROMPT', 'agent rules'])
		expect(requests[1]?.toolNames).toEqual(['apply_patch'])
		expect(requests[1]?.openAiConfig).toEqual({
			model: 'gpt-5.5',
			reasoning: { effort: 'medium', summary: 'auto' },
		})
		expect(requests[1]?.anthropicConfig).toBeNull()
	}),
)

it.effect('codex-family agents get apply_patch instead of write/edit, with codex reasoning applied', () =>
	Effect.gen(function* () {
		const scripted = yield* makeScriptedLanguageModel([textTurn('done')])
		const layer = familyAgentLayer(scripted.layer)

		const started = yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			const entry = yield* runtime.start(startInput({ model: codexModel }))
			yield* runtime.run(runInput('go'))

			return entry
		}).pipe(Effect.provide(layer))

		expect(started.tools).toEqual(['apply_patch'])

		const requests = yield* scripted.requests
		expect(requests[0]?.toolNames).toEqual(['apply_patch'])
		expect(requests[0]?.openAiConfig).toEqual({
			model: 'gpt-5.5',
			reasoning: { effort: 'medium', summary: 'auto' },
		})
	}),
)

it.effect('claude-family agents get write/edit instead of apply_patch', () =>
	Effect.gen(function* () {
		const scripted = yield* makeScriptedLanguageModel([textTurn('done')])
		const layer = familyAgentLayer(scripted.layer)

		const started = yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			const entry = yield* runtime.start(startInput({ model: claudeOffModel }))
			yield* runtime.run(runInput('go'))

			return entry
		}).pipe(Effect.provide(layer))

		expect(started.tools).toEqual(['write', 'edit'])

		const requests = yield* scripted.requests
		expect(requests[0]?.toolNames).toEqual(['write', 'edit'])
		expect(requests[0]?.anthropicConfig).toBeNull()
		expect(requests[0]?.openAiConfig).toBeNull()
	}),
)
