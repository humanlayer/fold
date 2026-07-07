import { it, expect } from '@effect/vitest'
import { Effect, Layer, Schema, Stream } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import {
	EventLog,
	Ids,
	layerInMemoryEventLog,
	messagesForAgent,
	runtimeForAgent,
	toolStateForAgent,
	ToolCallId,
	type ActiveModel,
	type LogEntry,
	type SystemMessageEncoded,
	type ToolMessageEncoded,
	type UserMessageEncoded,
} from '../../src/index'
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime'

const testLayer = Layer.mergeAll(layerInMemoryEventLog, layerDeterministicRuntime({ startMillis: 10_000 }))

const model: ActiveModel = {
	providerId: 'primary',
	providerKind: 'openai-compatible',
	modelId: 'gpt-test',
	role: 'smart',
	requestedReasoningLevel: 'low',
	reasoning: { _tag: 'effort', effort: 'low' },
}

const fastModel: ActiveModel = {
	providerId: 'primary',
	providerKind: 'openai-compatible',
	modelId: 'gpt-test-fast',
	role: 'fast',
	requestedReasoningLevel: 'minimal',
	reasoning: { _tag: 'effort', effort: 'minimal' },
}

const systemMessage = (content: string): SystemMessageEncoded =>
	Schema.encodeUnknownSync(Prompt.SystemMessage)(Prompt.systemMessage({ content }))

const userMessage = (text: string): UserMessageEncoded =>
	Schema.encodeUnknownSync(Prompt.UserMessage)(Prompt.userMessage({ content: [Prompt.textPart({ text })] }))

const assistantWithToolCalls = (toolCallIds: ReadonlyArray<ToolCallId>) =>
	Schema.encodeUnknownSync(Prompt.AssistantMessage)(
		Prompt.assistantMessage({
			content: toolCallIds.map((id, index) =>
				Prompt.toolCallPart({ id, name: `tool_${index}`, params: { index }, providerExecuted: false }),
			),
		}),
	)

const toolMessage = (toolCallId: ToolCallId, index: number): ToolMessageEncoded =>
	Schema.encodeUnknownSync(Prompt.ToolMessage)(
		Prompt.toolMessage({
			content: [
				Prompt.toolResultPart({
					id: toolCallId,
					name: `tool_${index}`,
					isFailure: false,
					result: { index },
				}),
			],
		}),
	)

const messageId = Effect.flatMap(Ids, (ids) => ids.makeMessageId)
const stateId = Effect.flatMap(Ids, (ids) => ids.makeStateId)
const toolCallId = Effect.flatMap(Ids, (ids) => ids.makeToolCallId)
const agentId = Effect.flatMap(Ids, (ids) => ids.makeAgentId)

const appendRoot = (tools: ReadonlyArray<string> = ['read']) =>
	Effect.gen(function* () {
		const ids = yield* Ids
		const log = yield* EventLog
		const rootAgentId = yield* ids.makeAgentId

		yield* log.append({
			_tag: 'session_started',
			agentId: null,
			parentAgentId: null,
			toolCallId: null,
			version: 1,
			cwd: '/tmp/project',
			sessionId: yield* ids.makeSessionId,
			rootAgentId,
			meta: {},
		})
		yield* log.append({
			_tag: 'agent_started',
			agentId: rootAgentId,
			parentAgentId: null,
			toolCallId: null,
			mode: 'fresh',
			model,
			tools: [...tools],
			skill: null,
			fork: null,
		})

		return rootAgentId
	})

const readEntries = Effect.flatMap(EventLog, (log) => Stream.runCollect(log.entries()))

const lastSeq = (entries: ReadonlyArray<LogEntry>) => {
	const entry = entries.at(-1)
	if (entry === undefined) throw new Error('Expected at least one log entry')

	return entry.seq
}

it.effect('projects runtime state and tool state from the log', () =>
	Effect.gen(function* () {
		const result = yield* Effect.gen(function* () {
			const log = yield* EventLog
			const rootAgentId = yield* appendRoot(['read'])
			const firstToolCallId = yield* toolCallId

			yield* log.append({
				_tag: 'model-change',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				model: fastModel,
				reason: 'test',
			})
			yield* log.append({
				_tag: 'thinking-change',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				reasoningLevel: 'high',
				reason: 'test',
			})
			yield* log.append({
				_tag: 'tools-change',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				tools: ['read', 'bash'],
				reason: 'test',
			})
			yield* log.append({
				_tag: 'tool_state',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: firstToolCallId,
				namespace: 'read',
				stateId: yield* stateId,
				key: 'a.txt',
				value: { hash: 'old' },
			})
			yield* log.append({
				_tag: 'tool_state',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: firstToolCallId,
				namespace: 'read',
				stateId: yield* stateId,
				key: 'a.txt',
				value: null,
			})
			yield* log.append({
				_tag: 'tool_state',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: firstToolCallId,
				namespace: 'read',
				stateId: yield* stateId,
				key: 'b.txt',
				value: { hash: 'new' },
			})

			const entries = yield* readEntries

			return { entries, rootAgentId }
		}).pipe(Effect.provide(testLayer))

		const runtime = runtimeForAgent(result.entries, result.rootAgentId)
		const readState = toolStateForAgent(result.entries, result.rootAgentId, 'read')

		expect(runtime.activeModel?.modelId).toBe('gpt-test-fast')
		expect(runtime.activeTools).toEqual(['read', 'bash'])
		expect(runtime.reasoningLevel).toBe('high')
		expect(runtime.isRunning).toBe(true)
		expect(readState).toEqual({ 'b.txt': { hash: 'new' } })
	}),
)

it.effect('projects messages with the latest leading system message and assistant tool-call ordering', () =>
	Effect.gen(function* () {
		const result = yield* Effect.gen(function* () {
			const log = yield* EventLog
			const rootAgentId = yield* appendRoot()
			const firstToolCallId = yield* toolCallId
			const secondToolCallId = yield* toolCallId

			yield* log.append({
				_tag: 'system-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				messages: [systemMessage('old system')],
				placement: 'leading',
			})
			yield* log.append({
				_tag: 'system-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				messages: [systemMessage('new system'), systemMessage('stay terse')],
				placement: 'leading',
			})
			yield* log.append({
				_tag: 'user-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				message: userMessage('hello'),
			})
			yield* log.append({
				_tag: 'assistant-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				message: assistantWithToolCalls([firstToolCallId, secondToolCallId]),
				finish: null,
			})
			yield* log.append({
				_tag: 'tool-result',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: secondToolCallId,
				messageId: yield* messageId,
				message: toolMessage(secondToolCallId, 1),
			})
			yield* log.append({
				_tag: 'tool-result',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: firstToolCallId,
				messageId: yield* messageId,
				message: toolMessage(firstToolCallId, 0),
			})

			return { entries: yield* readEntries, firstToolCallId, rootAgentId, secondToolCallId }
		}).pipe(Effect.provide(testLayer))

		const projected = messagesForAgent(result.entries, result.rootAgentId)

		expect(projected.map((message) => message._tag)).toEqual([
			'system-message',
			'user-message',
			'assistant-message',
			'tool-result',
			'tool-result',
		])
		expect(projected[0]).toMatchObject({
			_tag: 'system-message',
			messages: [{ content: 'new system' }, { content: 'stay terse' }],
		})
		expect(projected[3]).toMatchObject({ _tag: 'tool-result', toolCallId: result.firstToolCallId })
		expect(projected[4]).toMatchObject({ _tag: 'tool-result', toolCallId: result.secondToolCallId })
	}),
)

it.effect('projects forked agents through the parent fork sequence plus child entries', () =>
	Effect.gen(function* () {
		const result = yield* Effect.gen(function* () {
			const log = yield* EventLog
			const rootAgentId = yield* appendRoot()

			yield* log.append({
				_tag: 'system-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				messages: [systemMessage('root system')],
				placement: 'leading',
			})
			yield* log.append({
				_tag: 'user-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				message: userMessage('parent before fork'),
			})

			const forkAtSeq = lastSeq(yield* readEntries)
			const dispatchToolCallId = yield* toolCallId
			const childAgentId = yield* agentId

			yield* log.append({
				_tag: 'user-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				message: userMessage('parent after fork'),
			})
			yield* log.append({
				_tag: 'agent_started',
				agentId: childAgentId,
				parentAgentId: rootAgentId,
				toolCallId: dispatchToolCallId,
				mode: 'fork',
				model,
				tools: ['read'],
				skill: null,
				fork: { fromAgentId: rootAgentId, atSeq: forkAtSeq },
			})
			yield* log.append({
				_tag: 'user-message',
				agentId: childAgentId,
				parentAgentId: rootAgentId,
				toolCallId: dispatchToolCallId,
				messageId: yield* messageId,
				message: userMessage('child prompt'),
			})

			return { childAgentId, entries: yield* readEntries }
		}).pipe(Effect.provide(testLayer))

		const projected = messagesForAgent(result.entries, result.childAgentId)

		expect(projected.map((message) => message._tag)).toEqual(['system-message', 'user-message', 'user-message'])
		expect(projected[1]).toMatchObject({ _tag: 'user-message', message: { content: 'parent before fork' } })
		expect(projected[2]).toMatchObject({ _tag: 'user-message', message: { content: 'child prompt' } })
	}),
)

it.effect('projects compaction as a summary plus entries after the cut', () =>
	Effect.gen(function* () {
		const result = yield* Effect.gen(function* () {
			const log = yield* EventLog
			const ids = yield* Ids
			const rootAgentId = yield* appendRoot()

			yield* log.append({
				_tag: 'system-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				messages: [systemMessage('system survives')],
				placement: 'leading',
			})
			yield* log.append({
				_tag: 'user-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				message: userMessage('old user'),
			})

			const cutSeq = lastSeq(yield* readEntries)

			yield* log.append({
				_tag: 'compaction',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				compactionId: yield* ids.makeCompactionId,
				summary: 'summary of old history',
				replacesThroughSeq: cutSeq,
				tokensBefore: 123,
			})
			yield* log.append({
				_tag: 'user-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				message: userMessage('new user'),
			})

			return { entries: yield* readEntries, rootAgentId }
		}).pipe(Effect.provide(testLayer))

		const projected = messagesForAgent(result.entries, result.rootAgentId)

		expect(projected.map((message) => message._tag)).toEqual([
			'system-message',
			'compaction-summary',
			'user-message',
		])
		expect(projected[1]).toMatchObject({ _tag: 'compaction-summary', summary: 'summary of old history' })
		expect(projected[2]).toMatchObject({ _tag: 'user-message', message: { content: 'new user' } })
	}),
)

it.effect('drops all pre-compaction messages except the leading system message', () =>
	Effect.gen(function* () {
		const result = yield* Effect.gen(function* () {
			const log = yield* EventLog
			const ids = yield* Ids
			const rootAgentId = yield* appendRoot()
			const oldToolCallId = yield* toolCallId
			const newToolCallId = yield* toolCallId

			yield* log.append({
				_tag: 'system-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				messages: [systemMessage('system survives compaction')],
				placement: 'leading',
			})
			yield* log.append({
				_tag: 'user-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				message: userMessage('old user should be hidden'),
			})
			yield* log.append({
				_tag: 'assistant-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				message: assistantWithToolCalls([oldToolCallId]),
				finish: null,
			})
			yield* log.append({
				_tag: 'tool-result',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: oldToolCallId,
				messageId: yield* messageId,
				message: toolMessage(oldToolCallId, 0),
			})

			const cutSeq = lastSeq(yield* readEntries)

			yield* log.append({
				_tag: 'compaction',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				compactionId: yield* ids.makeCompactionId,
				summary: 'compacted old user, assistant, and tool result',
				replacesThroughSeq: cutSeq,
				tokensBefore: 456,
			})
			yield* log.append({
				_tag: 'user-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				message: userMessage('new user is visible'),
			})
			yield* log.append({
				_tag: 'assistant-message',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: yield* messageId,
				message: assistantWithToolCalls([newToolCallId]),
				finish: null,
			})
			yield* log.append({
				_tag: 'tool-result',
				agentId: rootAgentId,
				parentAgentId: null,
				toolCallId: newToolCallId,
				messageId: yield* messageId,
				message: toolMessage(newToolCallId, 0),
			})

			return { entries: yield* readEntries, newToolCallId, rootAgentId }
		}).pipe(Effect.provide(testLayer))

		const projected = messagesForAgent(result.entries, result.rootAgentId)

		expect(projected.map((message) => message._tag)).toEqual([
			'system-message',
			'compaction-summary',
			'user-message',
			'assistant-message',
			'tool-result',
		])
		expect(projected[0]).toMatchObject({
			_tag: 'system-message',
			messages: [{ content: 'system survives compaction' }],
		})
		expect(projected[1]).toMatchObject({
			_tag: 'compaction-summary',
			summary: 'compacted old user, assistant, and tool result',
		})
		expect(projected[2]).toMatchObject({ _tag: 'user-message', message: { content: 'new user is visible' } })
		expect(projected[4]).toMatchObject({ _tag: 'tool-result', toolCallId: result.newToolCallId })
		expect(projected).not.toContainEqual(
			expect.objectContaining({
				_tag: 'user-message',
				message: expect.objectContaining({ content: 'old user should be hidden' }),
			}),
		)
	}),
)
