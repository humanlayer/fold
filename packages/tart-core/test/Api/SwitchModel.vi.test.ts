/**
 * Facade switch tests: `TartSession.switchModel` re-provisions the runtime for a new provider and
 * durably records the full configuration change - `model-change`, the recomposed leading
 * `system-message`, `tools-change` over the (possibly replaced) installed toolset, and
 * `thinking-change` when the reasoning level changed. Every assertion runs against both the durable
 * log and the requests the scripted per-epoch models actually received.
 */
import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import {
	defineAgent,
	defineTool,
	startSession,
	type ActiveModel,
	type AgentStartedLogEntry,
	type ModelChangeLogEntry,
	type SystemMessageLogEntry,
	type ThinkingChangeLogEntry,
	type ToolsChangeLogEntry,
} from '../../src/index'
import { textTurn, toolCallTurn, type ScriptedRequest } from '../TestLayers/ScriptedLanguageModel'
import { claudeActiveModel, echoTool, gptActiveModel, makeRecordedTool, scriptedModel } from './ApiTestHelpers'

/** The system-role contents of one recorded request's prompt, in order. */
const systemContents = (request: ScriptedRequest | undefined): ReadonlyArray<string> =>
	request === undefined
		? []
		: request.prompt.content.flatMap((message) => (message.role === 'system' ? [message.content] : []))

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

		// Both models request at level `off`, so the transition writes no thinking-change entry.
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
		expect(systemContents(claudeRequest)).toEqual(['Claude base.', 'Agent block.'])

		// The old epoch really advertised the gpt-family toolset.
		const gptRequest = (yield* first.scripted.requests)[0]
		expect(gptRequest?.toolNames).toEqual(['echo', 'apply_patch'])
	}).pipe(Effect.scoped),
)

it.effect('switchModel can replace the agent prompt blocks, and the replacement sticks for later switches', () =>
	Effect.gen(function* () {
		const first = yield* scriptedModel(gptActiveModel, [textTurn('one')])
		const second = yield* scriptedModel(claudeActiveModel, [textTurn('two')])
		const third = yield* scriptedModel({ ...gptActiveModel, modelId: 'gpt-scripted-2' }, [textTurn('three')])

		const session = yield* startSession({
			agent: defineAgent({
				model: first.model,
				systemPrompt: 'Original block.',
				basePrompts: { gpt: 'GPT base.', claude: 'Claude base.' },
			}),
		})

		yield* session.send('turn one')

		// Switch two changes the agent's own prompt blocks alongside the provider.
		yield* session.switchModel(second.model, { systemPrompt: 'Replacement block.', reason: 'new prompt' })
		yield* session.send('turn two')

		// Switch three passes no prompt: the replaced blocks carry forward.
		yield* session.switchModel(third.model, { reason: 'back to gpt' })
		yield* session.send('turn three')

		const entries = yield* session.entries
		const leadingBlocks = entries
			.filter((entry): entry is SystemMessageLogEntry => entry._tag === 'system-message')
			.map((entry) => entry.messages.map((message) => message.content))
		expect(leadingBlocks).toEqual([
			['GPT base.', 'Original block.'],
			['Claude base.', 'Replacement block.'],
			['GPT base.', 'Replacement block.'],
		])

		// Each epoch's model was sent exactly the leading prompt its epoch recorded.
		expect(systemContents((yield* first.scripted.requests)[0])).toEqual(['GPT base.', 'Original block.'])
		expect(systemContents((yield* second.scripted.requests)[0])).toEqual(['Claude base.', 'Replacement block.'])
		expect(systemContents((yield* third.scripted.requests)[0])).toEqual(['GPT base.', 'Replacement block.'])
	}).pipe(Effect.scoped),
)

it.effect('switchModel can replace the installed tools; the new tool executes and the change lands durably', () =>
	Effect.gen(function* () {
		const oldTool = yield* makeRecordedTool('echo')
		const newTool = yield* makeRecordedTool('lookup')

		const first = yield* scriptedModel(gptActiveModel, [textTurn('no tools used')])
		const second = yield* scriptedModel(claudeActiveModel, [
			toolCallTurn([{ id: 'provider-call-1', name: 'lookup', params: { text: 'find me' } }]),
			textTurn('lookup done'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model: first.model, systemPrompt: 'Agent block.', tools: [oldTool.tool] }),
		})

		yield* session.send('turn one')
		yield* session.switchModel(second.model, { tools: [newTool.tool], reason: 'swap toolset' })
		const finished = yield* session.send('use lookup')

		expect(finished.resultText).toBe('lookup done')

		// The replacement toolset executed for real - settlement ran against the new Toolset, not the old one.
		expect(yield* newTool.calls).toEqual(['find me'])
		expect(yield* oldTool.calls).toEqual([])

		// Durable facts: the epoch transition recorded the newly installed toolset...
		const entries = yield* session.entries
		const toolsChange = entries.find((entry): entry is ToolsChangeLogEntry => entry._tag === 'tools-change')
		expect(toolsChange?.tools).toEqual(['lookup'])
		expect(entries.some((entry) => entry._tag === 'tool-result')).toBe(true)

		// ...and each epoch's request advertised its own toolset.
		expect((yield* first.scripted.requests)[0]?.toolNames).toEqual(['echo'])
		expect((yield* second.scripted.requests)[0]?.toolNames).toEqual(['lookup'])
	}).pipe(Effect.scoped),
)

it.effect('switchModel records thinking-change when the reasoning level changes and binds it on the next request', () =>
	Effect.gen(function* () {
		const highGptModel: ActiveModel = {
			...gptActiveModel,
			modelId: 'gpt-scripted-high',
			requestedReasoningLevel: 'high',
			reasoning: { _tag: 'effort', effort: 'high' },
		}

		const first = yield* scriptedModel(gptActiveModel, [textTurn('level off')])
		const second = yield* scriptedModel(highGptModel, [textTurn('level high')])

		const session = yield* startSession({
			agent: defineAgent({ model: first.model, systemPrompt: 'Agent block.' }),
		})

		yield* session.send('turn one')
		yield* session.switchModel(second.model, { reason: 'raise reasoning' })
		yield* session.send('turn two')

		// The transition carries all four durable facts, thinking-change last.
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
			'thinking-change',
			'user-message',
			'assistant-message',
			'agent-finished',
		])

		const thinkingChange = entries.find(
			(entry): entry is ThinkingChangeLogEntry => entry._tag === 'thinking-change',
		)
		expect(thinkingChange?.reasoningLevel).toBe('high')
		expect(thinkingChange?.reason).toBe('raise reasoning')

		// The first epoch sent no reasoning config; the new epoch binds the raised level per request.
		expect((yield* first.scripted.requests)[0]?.openAiConfig).toEqual({ model: 'gpt-scripted' })
		expect((yield* second.scripted.requests)[0]?.openAiConfig).toEqual({
			model: 'gpt-scripted-high',
			reasoning: { effort: 'high' },
		})
	}).pipe(Effect.scoped),
)

it.effect('switchModel rejects duplicate tool names in the replacement toolset as a defect', () =>
	Effect.gen(function* () {
		const first = yield* scriptedModel(gptActiveModel, [textTurn('one')])
		const second = yield* scriptedModel(claudeActiveModel, [])

		const session = yield* startSession({ agent: defineAgent({ model: first.model }) })
		yield* session.send('turn one')

		const exit = yield* session.switchModel(second.model, { tools: [echoTool, echoTool] }).pipe(Effect.exit)

		expect(exit._tag).toBe('Failure')
		expect(String(exit)).toContain('duplicate tool names: echo')
	}).pipe(Effect.scoped),
)
