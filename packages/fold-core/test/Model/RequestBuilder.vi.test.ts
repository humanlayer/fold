import { expect, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import type { Prompt } from 'effect/ai'

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
const secondToolCallId = ToolCallId.make('tool_call_bbbbbbbbbbbbbbbbbbbbbbbb')
const orphanToolCallId = ToolCallId.make('tool_call_cccccccccccccccccccccccc')
const compactionId = CompactionId.make('compaction_aaaaaaaaaaaaaaaaaaaaaaaa')
const missingToolResult =
	'<system-information>No result was recorded for this tool call. The reason is unknown. The tool may have completed; check the current state before retrying.</system-information>'

const projectedAssistant = (
	calls: ReadonlyArray<{
		readonly id: ToolCallId
		readonly providerId: string
		readonly name: string
		readonly providerExecuted?: boolean
	}>,
	text?: string,
): Extract<ProjectedMessage, { readonly _tag: 'assistant-message' }> => ({
	_tag: 'assistant-message',
	sourceSeq: 1,
	messageId,
	finish: null,
	message: {
		role: 'assistant',
		content: [
			...(text === undefined ? [] : [{ type: 'text' as const, text }]),
			...calls.map((call) => ({
				type: 'tool-call' as const,
				id: call.id,
				name: call.name,
				params: { value: call.name },
				providerExecuted: call.providerExecuted ?? false,
				options: { fold: { providerToolCallId: call.providerId } },
			})),
		],
	},
})

const projectedToolResult = (
	outerId: ToolCallId,
	innerId: ToolCallId,
	result: unknown,
	sourceSeq = 2,
	isFailure = false,
): Extract<ProjectedMessage, { readonly _tag: 'tool-result' }> => ({
	_tag: 'tool-result',
	sourceSeq,
	messageId,
	toolCallId: outerId,
	message: {
		role: 'tool',
		content: [{ type: 'tool-result', id: innerId, name: 'echo', result, isFailure }],
	},
})

const toolResultsFrom = (prompt: Prompt.Prompt): ReadonlyArray<Prompt.ToolResultPart> =>
	prompt.content.flatMap((message) =>
		message.role === 'tool'
			? message.content.filter((part): part is Prompt.ToolResultPart => part.type === 'tool-result')
			: [],
	)

const projectedConversation: ReadonlyArray<ProjectedMessage> = [
	{
		_tag: 'system-message',
		sourceSeq: 1,
		messageId,
		placement: 'leading',
		messages: [{ role: 'system', content: 'be brief' }],
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
					options: { fold: { providerToolCallId: 'provider-call-1' } },
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
			content: [
				{ type: 'tool-result', id: toolCallId, name: 'echo', result: { echoed: 'hi' }, isFailure: false },
			],
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
		expect(toolMessage?.options.anthropic).toEqual({ cacheControl: { type: 'ephemeral' } })
	}),
)

it.effect('synthesizes a failed result for a dangling call without removing assistant content', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt([
			projectedAssistant([{ id: toolCallId, providerId: 'provider-call-1', name: 'echo' }], 'working on it'),
			{
				_tag: 'user-message',
				sourceSeq: 2,
				messageId,
				message: { role: 'user', content: [{ type: 'text', text: 'continue' }] },
			},
		])

		expect(prompt.content.map((message) => message.role)).toEqual(['assistant', 'tool', 'user'])
		const assistant = prompt.content[0]
		if (assistant?.role !== 'assistant') throw new Error('expected an assistant message')
		expect(assistant.content.some((part) => part.type === 'text' && part.text === 'working on it')).toBe(true)

		const results = toolResultsFrom(prompt)
		expect(results).toHaveLength(1)
		expect(results[0]).toMatchObject({
			id: 'provider-call-1',
			name: 'echo',
			result: missingToolResult,
			isFailure: true,
			providerExecuted: false,
		})
	}),
)

it.effect('keeps completed results and synthesizes only missing results in a partial batch', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt([
			projectedAssistant([
				{ id: toolCallId, providerId: 'provider-call-1', name: 'first' },
				{ id: secondToolCallId, providerId: 'provider-call-2', name: 'second' },
			]),
			projectedToolResult(secondToolCallId, secondToolCallId, { value: 'completed' }),
		])

		expect(toolResultsFrom(prompt)).toMatchObject([
			{ id: 'provider-call-1', name: 'first', result: missingToolResult, isFailure: true },
			{ id: 'provider-call-2', result: { value: 'completed' }, isFailure: false },
		])
	}),
)

it.effect('leaves a complete multi-call batch unchanged', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt([
			projectedAssistant([
				{ id: toolCallId, providerId: 'provider-call-1', name: 'first' },
				{ id: secondToolCallId, providerId: 'provider-call-2', name: 'second' },
			]),
			projectedToolResult(toolCallId, toolCallId, { value: 'first completed' }, 2),
			projectedToolResult(secondToolCallId, secondToolCallId, { value: 'second completed' }, 3),
		])

		expect(toolResultsFrom(prompt)).toMatchObject([
			{ id: 'provider-call-1', result: { value: 'first completed' }, isFailure: false },
			{ id: 'provider-call-2', result: { value: 'second completed' }, isFailure: false },
		])
		expect(JSON.stringify(prompt.content)).not.toContain(missingToolResult)
	}),
)

it.effect('preserves a valid failed tool result without replacing it', () =>
	Effect.gen(function* () {
		const persistedFailure = '<system-information>Tool "echo" failed unexpectedly: boom</system-information>'
		const prompt = yield* buildPrompt([
			projectedAssistant([{ id: toolCallId, providerId: 'provider-call-1', name: 'echo' }]),
			projectedToolResult(toolCallId, toolCallId, persistedFailure, 2, true),
		])

		expect(toolResultsFrom(prompt)).toMatchObject([
			{ id: 'provider-call-1', result: persistedFailure, isFailure: true },
		])
		expect(JSON.stringify(prompt.content)).not.toContain(missingToolResult)
	}),
)

it.effect('replaces duplicate results with one synthetic failure', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt([
			projectedAssistant([{ id: toolCallId, providerId: 'provider-call-1', name: 'echo' }]),
			projectedToolResult(toolCallId, toolCallId, { value: 'first' }, 2),
			projectedToolResult(toolCallId, toolCallId, { value: 'second' }, 3),
		])

		expect(toolResultsFrom(prompt)).toMatchObject([
			{ id: 'provider-call-1', result: missingToolResult, isFailure: true },
		])
	}),
)

it.effect('replaces an outer and inner id mismatch with a synthetic failure', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt([
			projectedAssistant([{ id: toolCallId, providerId: 'provider-call-1', name: 'echo' }]),
			projectedToolResult(toolCallId, orphanToolCallId, { value: 'mismatched' }),
		])

		expect(toolResultsFrom(prompt)).toMatchObject([
			{ id: 'provider-call-1', result: missingToolResult, isFailure: true },
		])
	}),
)

it.effect('omits an orphan result from the provider prompt', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt([
			projectedToolResult(orphanToolCallId, orphanToolCallId, { value: 'orphaned' }),
			{
				_tag: 'user-message',
				sourceSeq: 2,
				messageId,
				message: { role: 'user', content: [{ type: 'text', text: 'continue' }] },
			},
		])

		expect(prompt.content.map((message) => message.role)).toEqual(['user'])
		expect(toolResultsFrom(prompt)).toEqual([])
	}),
)

it.effect('does not synthesize results for provider-executed calls', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt([
			{
				_tag: 'assistant-message',
				sourceSeq: 1,
				messageId,
				finish: null,
				message: {
					role: 'assistant',
					content: [
						{
							type: 'tool-call',
							id: toolCallId,
							name: 'web_search',
							params: { query: 'fold' },
							providerExecuted: true,
						},
					],
				},
			},
		])

		expect(prompt.content.map((message) => message.role)).toEqual(['assistant'])
		expect(toolResultsFrom(prompt)).toEqual([])
	}),
)

it.effect('synthesizes only local results in a mixed local and provider-executed batch', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt([
			projectedAssistant([
				{ id: toolCallId, providerId: 'provider-call-1', name: 'echo' },
				{
					id: secondToolCallId,
					providerId: 'provider-call-2',
					name: 'web_search',
					providerExecuted: true,
				},
			]),
		])

		expect(toolResultsFrom(prompt)).toMatchObject([
			{ id: 'provider-call-1', name: 'echo', result: missingToolResult, isFailure: true },
		])
	}),
)

it.effect('leaves a completed local result unchanged in a mixed provider-executed batch', () =>
	Effect.gen(function* () {
		const completedResult = { value: 'completed locally' }
		const prompt = yield* buildPrompt([
			projectedAssistant([
				{ id: toolCallId, providerId: 'provider-call-1', name: 'echo' },
				{
					id: secondToolCallId,
					providerId: 'provider-call-2',
					name: 'web_search',
					providerExecuted: true,
				},
			]),
			projectedToolResult(toolCallId, toolCallId, completedResult),
		])

		expect(toolResultsFrom(prompt)).toMatchObject([
			{ id: 'provider-call-1', name: 'echo', result: completedResult, isFailure: false },
		])
		expect(JSON.stringify(prompt.content)).not.toContain(missingToolResult)
	}),
)

it.effect('marks the latest user-side message as an Anthropic cache breakpoint', () =>
	Effect.gen(function* () {
		const prompt = yield* buildPrompt([
			{
				_tag: 'user-message',
				sourceSeq: 1,
				messageId,
				message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
			},
			{
				_tag: 'assistant-message',
				sourceSeq: 2,
				messageId,
				finish: null,
				message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
			},
			{
				_tag: 'user-message',
				sourceSeq: 3,
				messageId,
				message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
			},
		])

		const first = prompt.content[0]
		const second = prompt.content[2]
		if (first?.role !== 'user' || second?.role !== 'user') throw new Error('expected user messages')

		expect(first.options.anthropic).toBeUndefined()
		expect(second.options.anthropic).toEqual({ cacheControl: { type: 'ephemeral' } })
	}),
)

it.effect('renders every block of a multi-block system message as consecutive system messages', () =>
	Effect.gen(function* () {
		const multiBlock: ReadonlyArray<ProjectedMessage> = [
			{
				_tag: 'system-message',
				sourceSeq: 1,
				messageId,
				placement: 'leading',
				messages: [
					{ role: 'system', content: 'block one' },
					{ role: 'system', content: 'block two' },
				],
			},
			{
				_tag: 'user-message',
				sourceSeq: 2,
				messageId,
				message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
			},
		]

		const prompt = yield* buildPrompt(multiBlock)

		expect(prompt.content.map((message) => message.role)).toEqual(['system', 'system', 'user'])
		expect(prompt.content.flatMap((message) => (message.role === 'system' ? [message.content] : []))).toEqual([
			'block one',
			'block two',
		])
	}),
)

it.effect('keeps fold ids when no provider id was stashed', () =>
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
						{
							type: 'tool-call',
							id: toolCallId,
							name: 'echo',
							params: { text: 'hi' },
							providerExecuted: false,
						},
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
