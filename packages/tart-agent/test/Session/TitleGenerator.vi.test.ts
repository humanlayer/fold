import { describe, expect, it } from '@effect/vitest'
import { customModel, type LogEntry } from '@humanlayer/tart-core'
import { Effect, Stream } from 'effect'
import { LanguageModel, Response } from 'effect/unstable/ai'

import {
	fallbackSessionTitle,
	generateSessionTitle,
	normalizeSessionTitle,
	titleTranscript,
} from '../../src/Session/TitleGenerator'

const root = 'agent_root'
const entries = [
	{
		_tag: 'user-message',
		seq: 1,
		agentId: root,
		message: { role: 'user', content: 'Fix the session title cache' },
	},
	{
		_tag: 'assistant-message',
		seq: 2,
		agentId: root,
		message: { role: 'assistant', content: [{ type: 'text', text: 'I will inspect it.' }] },
	},
	{
		_tag: 'user-message',
		seq: 3,
		agentId: 'agent_child',
		message: { role: 'user', content: 'secret subagent prompt' },
	},
] as unknown as ReadonlyArray<LogEntry>

describe('session title generation inputs', () => {
	const modelWith = (
		generateText: (options: LanguageModel.ProviderOptions) => Effect.Effect<Array<Response.PartEncoded>>,
	) =>
		customModel({
			activeModel: {
				providerId: 'stub',
				providerKind: 'openai-compatible',
				modelId: 'title-stub',
				role: null,
				requestedReasoningLevel: 'off',
				reasoning: { _tag: 'disabled' },
			},
			make: LanguageModel.make({ generateText, streamText: () => Stream.empty }),
		})
	it('normalizes whitespace, quotes, and word count', () => {
		expect(normalizeSessionTitle('  "one two three four five six seven"\n')).toBe('one two three four five six')
	})

	it('uses the first root user message as the bounded fallback', () => {
		expect(fallbackSessionTitle(entries, root)).toBe('Fix the session title cache')
	})

	it('includes root user and assistant text but excludes subagents', () => {
		const transcript = titleTranscript(entries, root)
		expect(transcript).toContain('User: Fix the session title cache')
		expect(transcript).toContain('Assistant: I will inspect it.')
		expect(transcript).not.toContain('secret subagent prompt')
	})

	it.effect('uses a real custom TartModel structured response', () =>
		Effect.gen(function* () {
			const model = modelWith(() =>
				Effect.succeed<Array<Response.PartEncoded>>([
					{ type: 'text', text: '{"title":"Harden Concurrent Session Titles"}' },
				]),
			)
			expect(yield* generateSessionTitle(entries, root, model)).toBe('Harden Concurrent Session Titles')
		}),
	)

	it.effect('falls back nonfatally when the structured model call fails', () =>
		Effect.gen(function* () {
			const model = modelWith(() => Effect.die(new Error('provider unavailable')))
			expect(yield* generateSessionTitle(entries, root, model)).toBe('Fix the session title cache')
		}),
	)
})
