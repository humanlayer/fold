import { expect, it } from '@effect/vitest'
import { Effect, Encoding } from 'effect'
import type { Prompt } from 'effect/unstable/ai'

import {
	buildPrompt,
	MessageId,
	ToolCallId,
	ToolResultImagePart,
	ToolResultMultipart,
	ToolResultText,
	ToolResultTextPart,
	type ProjectedMessage,
} from '../../src/index'

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

const onlyToolResult = (prompt: Prompt.Prompt): Prompt.ToolResultPart => {
	const toolMessage = prompt.content.find((message): message is Prompt.ToolMessage => message.role === 'tool')
	const toolResult = toolMessage?.content[0]
	if (toolResult?.type !== 'tool-result') throw new Error('expected a tool-result part')
	return toolResult
}

it.effect('lowers multipart results to text and file parts inside the original tool result', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt(
			conversationWith(
				ToolResultMultipart.make({
					content: [
						ToolResultTextPart.make({ text: 'Read image file [image/png]' }),
						ToolResultImagePart.make({ data: imageBase64, mediaType: 'image/png' }),
					],
				}),
			),
		)

		expect(prompt.content.map((message) => message.role)).toEqual(['assistant', 'tool'])
		const result = onlyToolResult(prompt).result
		if (!Array.isArray(result)) throw new Error('expected multipart Prompt content')
		expect(result).toHaveLength(2)
		expect(result[0]).toMatchObject({ type: 'text', text: 'Read image file [image/png]' })
		const image = result[1]
		if (image?.type !== 'file' || !(image.data instanceof Uint8Array)) throw new Error('expected image bytes')
		expect(image.mediaType).toBe('image/png')
		expect(Encoding.encodeBase64(image.data)).toBe(imageBase64)
	}),
)

it.effect('preserves multiple image parts in result order', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt(
			conversationWith(
				ToolResultMultipart.make({
					content: [
						ToolResultImagePart.make({ data: 'Zmlyc3Q=', mediaType: 'image/png' }),
						ToolResultImagePart.make({ data: 'c2Vjb25k', mediaType: 'image/jpeg' }),
					],
				}),
			),
		)

		const result = onlyToolResult(prompt).result
		if (!Array.isArray(result)) throw new Error('expected multipart Prompt content')
		expect(
			result.map((part) =>
				part.type === 'file' && part.data instanceof Uint8Array ? Encoding.encodeBase64(part.data) : null,
			),
		).toEqual(['Zmlyc3Q=', 'c2Vjb25k'])
		expect(result.map((part) => (part.type === 'file' ? part.mediaType : null))).toEqual([
			'image/png',
			'image/jpeg',
		])
	}),
)

it.effect('lowers canonical text results to exact strings', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt(conversationWith(ToolResultText.make({ text: 'plain text result' })))

		expect(prompt.content.map((message) => message.role)).toEqual(['assistant', 'tool'])
		expect(onlyToolResult(prompt).result).toBe('plain text result')
	}),
)

it.effect('leaves unknown custom results available for provider JSON fallback', () =>
	Effect.gen(function* () {
		const customResult = { echoed: 'hi' }
		const prompt = yield* buildPrompt(conversationWith(customResult))

		expect(onlyToolResult(prompt).result).toEqual(customResult)
	}),
)
