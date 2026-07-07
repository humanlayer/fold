import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { Prompt } from 'effect/unstable/ai'

import { buildPrompt, imageOmittedPlaceholder, MessageId, ToolCallId, type ProjectedMessage } from '../../src/index'

const messageId = MessageId.make('msg_aaaaaaaaaaaaaaaaaaaaaaaa')
const toolCallId = ToolCallId.make('tool_call_aaaaaaaaaaaaaaaaaaaaaaaa')

const imageBase64 = 'aGVsbG8taW1hZ2UtYnl0ZXM='

const conversationWith = (result: unknown): ReadonlyArray<ProjectedMessage> => [
	{
		_tag: 'assistant-message',
		sourceSeq: 1,
		messageId,
		finish: null,
		message: {
			role: 'assistant',
			content: [
				{ type: 'tool-call', id: toolCallId, name: 'read', params: { path: 'x.png' }, providerExecuted: false },
			],
		},
	},
	{
		_tag: 'tool-result',
		sourceSeq: 2,
		messageId,
		toolCallId,
		message: {
			role: 'tool',
			// oxlint-disable-next-line typescript/consistent-type-assertions
			content: [{ type: 'tool-result', id: toolCallId, name: 'read', result: result as never, isFailure: false }],
		},
	},
]

it.effect('lifts image blocks out of tool results into a user file-part message (D3)', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt(
			conversationWith({
				content: [
					{ type: 'text', text: 'Read image file [image/png]' },
					{ type: 'image', data: imageBase64, mimeType: 'image/png' },
				],
			}),
		)

		expect(prompt.content.map((message) => message.role)).toEqual(['assistant', 'tool', 'user'])

		const toolMessage = prompt.content.find((message): message is Prompt.ToolMessage => message.role === 'tool')
		const toolResult = toolMessage?.content[0]
		if (toolResult?.type !== 'tool-result') throw new Error('expected a tool-result part')

		// The image block inside the tool result was replaced by placeholder text.
		const sanitized = JSON.stringify(toolResult.result)
		expect(sanitized).not.toContain(imageBase64)
		expect(sanitized).toContain(imageOmittedPlaceholder)
		expect(sanitized).toContain('Read image file [image/png]')

		// The image itself follows as a native user-message file part.
		const followUp = prompt.content[2]
		if (followUp?.role !== 'user') throw new Error('expected a trailing user message')
		const fileParts = followUp.content.filter((part) => part.type === 'file')
		expect(fileParts).toHaveLength(1)
		expect(fileParts[0]?.mediaType).toBe('image/png')
		expect(fileParts[0]?.data).toBe(imageBase64)
	}),
)

it.effect('lifts multiple image blocks in result order', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt(
			conversationWith({
				content: [
					{ type: 'image', data: 'Zmlyc3Q=', mimeType: 'image/png' },
					{ type: 'image', data: 'c2Vjb25k', mimeType: 'image/jpeg' },
				],
			}),
		)

		const followUp = prompt.content[2]
		if (followUp?.role !== 'user') throw new Error('expected a trailing user message')
		const fileParts = followUp.content.filter((part) => part.type === 'file')
		expect(fileParts.map((part) => (typeof part.data === 'string' ? part.data : null))).toEqual([
			'Zmlyc3Q=',
			'c2Vjb25k',
		])
		expect(fileParts.map((part) => part.mediaType)).toEqual(['image/png', 'image/jpeg'])
	}),
)

it.effect('leaves text-only tool results untouched with no follow-up message', () =>
	Effect.gen(function* () {
		const result = { content: [{ type: 'text', text: 'plain text result' }] }
		const prompt = yield* buildPrompt(conversationWith(result))

		expect(prompt.content.map((message) => message.role)).toEqual(['assistant', 'tool'])

		const toolMessage = prompt.content[1]
		if (toolMessage?.role !== 'tool') throw new Error('expected a tool message')
		const toolResult = toolMessage.content[0]
		if (toolResult?.type !== 'tool-result') throw new Error('expected a tool-result part')
		expect(toolResult.result).toEqual(result)
	}),
)

it.effect('ignores results that do not follow the content-block convention', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt(conversationWith({ echoed: 'hi' }))

		expect(prompt.content.map((message) => message.role)).toEqual(['assistant', 'tool'])
	}),
)
