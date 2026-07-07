/**
 * Facade tests: startSession lowers agent/log/model descriptors into the full runtime graph. Real
 * EventLog, projections, hook runner, tool runtime, and session facade run under scripted language
 * models - only descriptors appear in test setup, mirroring how SDK callers use the API.
 */
import { expect, it } from '@effect/vitest'
import { Context, Effect, Layer, Schema, Stream } from 'effect'
import { LanguageModel } from 'effect/unstable/ai'

import {
	customModel,
	defineAgent,
	defineTool,
	eventLogSource,
	startSession,
	EventLog,
	layerInMemoryEventLog,
	type ActiveModel,
	type AgentStartedLogEntry,
	type ModelChangeLogEntry,
	type SessionStartedLogEntry,
	type SystemMessageLogEntry,
	type TartModel,
	type ToolsChangeLogEntry,
} from '../../src/index'
import {
	makeScriptedLanguageModel,
	textTurn,
	toolCallTurn,
	type ScriptedLanguageModel,
	type ScriptedTurn,
} from '../TestLayers/ScriptedLanguageModel'

const gptActiveModel: ActiveModel = {
	providerId: 'scripted-openai',
	providerKind: 'openai-compatible',
	modelId: 'gpt-scripted',
	role: null,
	requestedReasoningLevel: 'off',
	reasoning: { _tag: 'disabled' },
}

const claudeActiveModel: ActiveModel = {
	providerId: 'scripted-anthropic',
	providerKind: 'anthropic',
	modelId: 'claude-scripted',
	role: null,
	requestedReasoningLevel: 'off',
	thinking: { _tag: 'disabled' },
}

/** A scripted model exposed as a facade descriptor plus its recorded requests. */
const scriptedModel = (
	activeModel: ActiveModel,
	turns: ReadonlyArray<ScriptedTurn>,
): Effect.Effect<{ readonly model: TartModel; readonly scripted: ScriptedLanguageModel }> =>
	Effect.gen(function* () {
		const scripted = yield* makeScriptedLanguageModel(turns)
		const make = Layer.build(scripted.layer).pipe(
			Effect.map((context) => Context.get(context, LanguageModel.LanguageModel)),
		)

		return { model: customModel({ activeModel, make }), scripted }
	})

const echoTool = defineTool({
	name: 'echo',
	description: 'Echoes text back to the model.',
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.Struct({ echoed: Schema.String }),
	handler: ({ text }) => Effect.succeed({ echoed: text }),
})

it.effect('runs a tool-calling turn end to end from descriptors only', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([{ id: 'provider-call-1', name: 'echo', params: { text: 'hello facade' } }]),
			textTurn('The tool echoed: hello facade'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				name: 'facade-demo',
				model,
				systemPrompt: 'You are a test agent.',
				tools: [echoTool],
			}),
		})

		const finished = yield* session.send('echo something')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('The tool echoed: hello facade')

		expect(entries.map((entry) => entry._tag)).toEqual([
			'session_started',
			'agent_started',
			'system-message',
			'user-message',
			'assistant-message',
			'tool-result',
			'assistant-message',
			'agent-finished',
		])

		const sessionStarted = entries.find(
			(entry): entry is SessionStartedLogEntry => entry._tag === 'session_started',
		)
		expect(sessionStarted?.sessionId).toBe(session.sessionId)
		expect(sessionStarted?.meta['agentName']).toBe('facade-demo')

		const agentStarted = entries.find((entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started')
		expect(agentStarted?.agentId).toBe(session.rootAgentId)
		expect(agentStarted?.tools).toEqual(['echo'])

		expect(yield* scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

it.effect('runs a tool-free agent with defaults (memory log, no tools, no failure schema)', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [textTurn('Just text.')])

		const session = yield* startSession({ agent: defineAgent({ model }) })

		const finished = yield* session.send('hi')
		const requests = yield* scripted.requests

		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('Just text.')
		expect(requests).toHaveLength(1)
		expect(requests[0]?.toolNames).toEqual([])
	}).pipe(Effect.scoped),
)

it.effect('switchModel continues the same log on a new provider and records the epoch transition', () =>
	Effect.gen(function* () {
		// A second installed tool that the family policy hides from claude models, so the recorded
		// tools-change proves the toolset re-resolved for the new family.
		const patchTool = defineTool({
			name: 'apply_patch',
			description: 'Applies a patch (test stub).',
			parameters: Schema.Struct({ patch: Schema.String }),
			success: Schema.Struct({ ok: Schema.Boolean }),
			handler: () => Effect.succeed({ ok: true }),
		})

		const first = yield* scriptedModel(gptActiveModel, [textTurn('from gpt')])
		const second = yield* scriptedModel(claudeActiveModel, [textTurn('from claude')])

		const session = yield* startSession({
			agent: defineAgent({
				model: first.model,
				systemPrompt: 'Agent block.',
				basePrompts: { gpt: 'GPT base.', claude: 'Claude base.' },
				tools: [echoTool, patchTool],
			}),
		})

		const turnOne = yield* session.send('first turn')
		yield* session.switchModel(second.model, { reason: 'switch providers' })
		const turnTwo = yield* session.send('second turn')

		expect(turnOne.resultText).toBe('from gpt')
		expect(turnTwo.resultText).toBe('from claude')

		// Each provider served exactly its own epoch: the runtime actually swapped.
		expect(yield* first.scripted.remainingTurns).toBe(0)
		expect((yield* first.scripted.requests).length).toBe(1)
		expect((yield* second.scripted.requests).length).toBe(1)

		const entries = yield* session.entries
		expect(entries.map((entry) => entry._tag)).toEqual([
			'session_started',
			'agent_started',
			'system-message',
			'user-message',
			'assistant-message',
			'agent-finished',
			'model-change',
			'system-message',
			'tools-change',
			'user-message',
			'assistant-message',
			'agent-finished',
		])

		// The durable transition binds the new model, the recomposed family prompt, and the re-resolved toolset.
		const modelChange = entries.find((entry): entry is ModelChangeLogEntry => entry._tag === 'model-change')
		expect(modelChange?.model.modelId).toBe('claude-scripted')
		expect(modelChange?.reason).toBe('switch providers')

		const systemEntries = entries.filter((entry): entry is SystemMessageLogEntry => entry._tag === 'system-message')
		expect(systemEntries[0]?.messages.map((message) => message.content)).toEqual(['GPT base.', 'Agent block.'])
		expect(systemEntries[1]?.messages.map((message) => message.content)).toEqual(['Claude base.', 'Agent block.'])

		const agentStarted = entries.find((entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started')
		expect(agentStarted?.tools).toEqual(['echo', 'apply_patch'])

		const toolsChange = entries.find((entry): entry is ToolsChangeLogEntry => entry._tag === 'tools-change')
		expect(toolsChange?.tools).toEqual(['echo'])

		// The new epoch's request advertises the re-resolved toolset and the recomposed leading prompt.
		const claudeRequest = (yield* second.scripted.requests)[0]
		expect(claudeRequest?.toolNames).toEqual(['echo'])
		const systemContents = claudeRequest?.prompt.content
			.filter((message) => message.role === 'system')
			.map((message) => message.content)
		expect(systemContents).toEqual(['Claude base.', 'Agent block.'])

		// The old epoch really advertised the gpt-family toolset.
		const gptRequest = (yield* first.scripted.requests)[0]
		expect(gptRequest?.toolNames).toEqual(['echo', 'apply_patch'])
	}).pipe(Effect.scoped),
)

it.effect('eventLogSource backs the session with a caller-supplied EventLog service', () =>
	Effect.gen(function* () {
		const external = yield* Layer.build(layerInMemoryEventLog).pipe(
			Effect.map((context) => Context.get(context, EventLog)),
		)
		const { model } = yield* scriptedModel(gptActiveModel, [textTurn('logged externally')])

		const session = yield* startSession({
			agent: defineAgent({ model, systemPrompt: 'You are a test agent.' }),
			log: eventLogSource(Effect.succeed(external)),
		})

		yield* session.send('hi')

		const externalEntries = yield* Stream.runCollect(external.entries())
		expect(externalEntries.map((entry) => entry._tag)).toEqual([
			'session_started',
			'agent_started',
			'system-message',
			'user-message',
			'assistant-message',
			'agent-finished',
		])
	}).pipe(Effect.scoped),
)

it.effect('rejects duplicate tool names as a defect', () =>
	Effect.gen(function* () {
		const { model } = yield* scriptedModel(gptActiveModel, [])

		const exit = yield* startSession({
			agent: defineAgent({ model, tools: [echoTool, echoTool] }),
		}).pipe(Effect.exit)

		expect(exit._tag).toBe('Failure')
		expect(String(exit)).toContain('duplicate tool names: echo')
	}).pipe(Effect.scoped),
)
