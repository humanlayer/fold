import { expect, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import {
	buildPrompt,
	CompactionId,
	MessageId,
	PromptDecodeError,
	ToolCallId,
	type ProjectedMessage,
} from '../../src/index'

const messageId = MessageId.make('msg_aaaaaaaaaaaaaaaaaaaaaaaa')
const toolCallId = ToolCallId.make('tool_call_aaaaaaaaaaaaaaaaaaaaaaaa')
const compactionId = CompactionId.make('compaction_aaaaaaaaaaaaaaaaaaaaaaaa')

const projectedConversation: ReadonlyArray<ProjectedMessage> = [
	{
		_tag: 'system-message',
		sourceSeq: 1,
		messageId,
		placement: 'leading',
		message: { role: 'system', content: 'be brief' },
	},
	{
		_tag: 'compaction-summary',
		sourceSeq: 2,
		compactionId,
		replacesThroughSeq: 1,
		summary: 'earlier we fixed the flaky test',
		tokensBefore: 900,
	},
	{
		_tag: 'user-message',
		sourceSeq: 3,
		messageId,
		message: { role: 'user', content: [{ type: 'text', text: 'now echo hi' }] },
	},
	{
		_tag: 'assistant-message',
		sourceSeq: 4,
		messageId,
		finish: null,
		message: {
			role: 'assistant',
			content: [
				{
					type: 'tool-call',
					id: toolCallId,
					name: 'echo',
					params: { text: 'hi' },
					providerExecuted: false,
					options: { tart: { providerToolCallId: 'provider-call-1' } },
				},
			],
		},
	},
	{
		_tag: 'tool-result',
		sourceSeq: 5,
		messageId,
		toolCallId,
		message: {
			role: 'tool',
			content: [{ type: 'tool-result', id: toolCallId, name: 'echo', result: { echoed: 'hi' }, isFailure: false }],
		},
	},
]

it.effect('decodes projected messages and restores provider tool-call ids on both sides', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt(projectedConversation)

		expect(prompt.content.map((message) => message.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool'])

		const compactionStandIn = prompt.content[1]
		expect(JSON.stringify(compactionStandIn)).toContain('earlier we fixed the flaky test')

		const assistant = prompt.content.find(
			(message): message is Prompt.AssistantMessage => message.role === 'assistant',
		)
		const toolCall = assistant?.content.find((part) => part.type === 'tool-call')
		if (toolCall?.type !== 'tool-call') throw new Error('expected a tool-call part')
		expect(toolCall.id).toBe('provider-call-1')
		expect(toolCall.params).toEqual({ text: 'hi' })

		const toolMessage = prompt.content.find((message): message is Prompt.ToolMessage => message.role === 'tool')
		const toolResult = toolMessage?.content.find((part) => part.type === 'tool-result')
		if (toolResult?.type !== 'tool-result') throw new Error('expected a tool-result part')
		expect(toolResult.id).toBe('provider-call-1')
	}),
)

it.effect('keeps tart ids when no provider id was stashed', () =>
	Effect.gen(function* () {
		const withoutStash: ReadonlyArray<ProjectedMessage> = [
			{
				_tag: 'assistant-message',
				sourceSeq: 1,
				messageId,
				finish: null,
				message: {
					role: 'assistant',
					content: [
						{ type: 'tool-call', id: toolCallId, name: 'echo', params: { text: 'hi' }, providerExecuted: false },
					],
				},
			},
		]

		const prompt = yield* buildPrompt(withoutStash)
		const assistant = prompt.content[0]
		if (assistant?.role !== 'assistant') throw new Error('expected an assistant message')

		const toolCall = assistant.content.find((part) => part.type === 'tool-call')
		if (toolCall?.type !== 'tool-call') throw new Error('expected a tool-call part')
		expect(toolCall.id).toBe(toolCallId)
	}),
)

it.effect('fails with PromptDecodeError carrying the source seq for undecodable history', () =>
	Effect.gen(function* () {
		const corrupt: ReadonlyArray<ProjectedMessage> = [
			{
				_tag: 'user-message',
				sourceSeq: 7,
				messageId,
				// Intentionally invalid encoded payload: this test exercises the decode-failure path.
				// oxlint-disable-next-line typescript/consistent-type-assertions
				message: { role: 'user', content: 42 } as never,
			},
		]

		const result = yield* buildPrompt(corrupt).pipe(Effect.result)

		if (!Result.isFailure(result)) throw new Error('expected buildPrompt to fail')
		expect(result.failure).toBeInstanceOf(PromptDecodeError)
		expect(result.failure.sourceSeq).toBe(7)
		expect(result.failure.entryTag).toBe('user-message')
	}),
)
