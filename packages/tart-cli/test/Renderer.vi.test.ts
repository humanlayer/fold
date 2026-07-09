import { expect, it } from '@effect/vitest'
import { AgentId, MessageId, SessionId } from '@humanlayer/tart-core'
import type { ModelCatalogEntry, UsageEncoded } from '@humanlayer/tart-core'
import { Effect } from 'effect'

import { makeOutputRenderer, responseCostUsd } from '../src/index'

it.effect('renders the session id in the header and finish line', () =>
	Effect.gen(function* () {
		const chunks: Array<string> = []
		const renderer = makeOutputRenderer({
			colors: false,
			stdout: (text) =>
				Effect.sync(() => {
					chunks.push(text)
				}),
		})
		const sessionId = SessionId.make('sess_aaaaaaaaaaaaaaaaaaaaaaaa')
		const agentId = AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
		const messageId = MessageId.make('msg_aaaaaaaaaaaaaaaaaaaaaaaa')

		yield* renderer.renderHeader({
			sessionId,
			cwd: '/tmp/project',
			logPath: '/tmp/tart/sessions/p/sess.jsonl',
			mode: 'new',
			model: {
				providerId: 'openai',
				providerKind: 'openai-compatible',
				modelId: 'gpt-test',
				role: 'smart',
				requestedReasoningLevel: 'off',
				reasoning: { _tag: 'disabled' },
			},
			credential: { _tag: 'found', detail: 'API key resolved for provider "openai"' },
		})
		yield* renderer.renderEvent({
			kind: 'log',
			entry: {
				_tag: 'assistant-message',
				seq: 2,
				ts: 1,
				agentId,
				parentAgentId: null,
				toolCallId: null,
				messageId,
				message: { options: {}, role: 'assistant', content: 'done text' },
				finish: {
					reason: 'stop',
					usage: {
						inputTokens: { uncached: 100, total: 100, cacheRead: 0, cacheWrite: undefined },
						outputTokens: { total: 10, text: 10, reasoning: 0 },
					},
				},
			},
		})
		yield* renderer.renderFinish({
			_tag: 'agent-finished',
			seq: 3,
			ts: 1,
			agentId,
			parentAgentId: null,
			toolCallId: null,
			outcome: 'completed',
			resultText: 'done text',
			reason: null,
		})

		const output = chunks.join('')
		expect(output).toContain(sessionId)
		expect(output).toContain(`session=${sessionId}`)
		expect(output).toContain(`agent=${agentId}`)
		expect(output).toContain(`resume tart --resume ${sessionId} --provider openai --model gpt-test --role smart`)
		expect(output).toContain('model openai/gpt-test')
		expect(output).toContain('credential found')
		expect(output).toContain('done text')
		expect(output).toContain('       0       --')
		// No catalog: Cost stays -- and Context divides by the interim pattern-table fallback (128k).
		expect(output).toContain('      --')
		expect(output).toContain('110/128,000 (0%)')
	}),
)

const gptTestCatalog: ReadonlyArray<ModelCatalogEntry> = [
	{
		providerId: 'openai',
		modelId: 'gpt-test',
		name: 'GPT Test',
		contextWindow: 32_000,
		maxInputTokens: null,
		maxOutputTokens: 8_000,
		reasoning: false,
		reasoningEfforts: null,
		vision: true,
		toolCall: true,
		pricing: {
			inputPerMTokens: 5,
			outputPerMTokens: 30,
			cacheReadPerMTokens: 0.5,
			cacheWritePerMTokens: null,
		},
	},
]

it.effect('with a catalog entry the usage table shows a real cost and the catalog context window', () =>
	Effect.gen(function* () {
		const chunks: Array<string> = []
		const renderer = makeOutputRenderer({
			colors: false,
			catalog: gptTestCatalog,
			stdout: (text) =>
				Effect.sync(() => {
					chunks.push(text)
				}),
		})
		const sessionId = SessionId.make('sess_bbbbbbbbbbbbbbbbbbbbbbbb')
		const agentId = AgentId.make('agent_bbbbbbbbbbbbbbbbbbbbbbbb')
		const messageId = MessageId.make('msg_bbbbbbbbbbbbbbbbbbbbbbbb')

		yield* renderer.renderHeader({
			sessionId,
			cwd: '/tmp/project',
			logPath: '/tmp/tart/sessions/p/sess.jsonl',
			mode: 'new',
			model: {
				providerId: 'openai',
				providerKind: 'openai-compatible',
				modelId: 'gpt-test',
				role: 'smart',
				requestedReasoningLevel: 'off',
				reasoning: { _tag: 'disabled' },
			},
			credential: { _tag: 'found', detail: 'API key resolved for provider "openai"' },
		})
		yield* renderer.renderEvent({
			kind: 'log',
			entry: {
				_tag: 'assistant-message',
				seq: 2,
				ts: 1,
				agentId,
				parentAgentId: null,
				toolCallId: null,
				messageId,
				message: { options: {}, role: 'assistant', content: 'done text' },
				finish: {
					reason: 'stop',
					usage: {
						inputTokens: { uncached: 100, total: 100, cacheRead: 0, cacheWrite: undefined },
						outputTokens: { total: 10, text: 10, reasoning: 0 },
					},
				},
			},
		})
		yield* renderer.renderFinish({
			_tag: 'agent-finished',
			seq: 3,
			ts: 1,
			agentId,
			parentAgentId: null,
			toolCallId: null,
			outcome: 'completed',
			resultText: 'done text',
			reason: null,
		})

		const output = chunks.join('')
		// Cost: 100 uncached x $5/M + 10 output x $30/M = $0.0008.
		expect(output).toContain('$0.0008')
		// Context: the catalog's 32k window replaces the pattern-table fallback as the denominator.
		expect(output).toContain('110/32,000 (0%)')
	}),
)

const usage = (input: UsageEncoded['inputTokens'], outputTotal: number): UsageEncoded => ({
	inputTokens: input,
	outputTokens: { total: outputTotal, text: outputTotal, reasoning: 0 },
})

const pricing = {
	inputPerMTokens: 5,
	outputPerMTokens: 25,
	cacheReadPerMTokens: 0.5,
	cacheWritePerMTokens: 6.25,
}

it('responseCostUsd bills cache reads/writes at their own rates and the rest at the input rate', () => {
	// total 1100 folds the cache components in (D11): uncached 100 x 5 + read 800 x 0.5 + write
	// 200 x 6.25 + output 50 x 25 = 500 + 400 + 1250 + 1250 = 3400 per-M units -> $0.0034.
	const cost = responseCostUsd(usage({ uncached: 100, total: 1_100, cacheRead: 800, cacheWrite: 200 }, 50), pricing)
	expect(cost).toBeCloseTo(0.0034, 10)
})

it('responseCostUsd treats unreported cache fields as zero', () => {
	const cost = responseCostUsd(
		usage({ uncached: undefined, total: 1_000, cacheRead: undefined, cacheWrite: undefined }, 100),
		pricing,
	)
	// 1000 x 5 + 100 x 25 = 7500 per-M units -> $0.0075.
	expect(cost).toBeCloseTo(0.0075, 10)
})

it('responseCostUsd returns null without pricing', () => {
	expect(responseCostUsd(usage({ uncached: 100, total: 100, cacheRead: 0, cacheWrite: 0 }, 10), null)).toBeNull()
})

it('responseCostUsd bills cache writes at the input rate when no cache-write price is published', () => {
	const cost = responseCostUsd(usage({ uncached: undefined, total: 300, cacheRead: 0, cacheWrite: 200 }, 0), {
		...pricing,
		cacheWritePerMTokens: null,
	})
	// (300 - 200) x 5 + 200 x 5 = 1500 per-M units -> $0.0015.
	expect(cost).toBeCloseTo(0.0015, 10)
})

it('responseCostUsd clamps the non-cached input component at zero', () => {
	const cost = responseCostUsd(
		usage({ uncached: undefined, total: 100, cacheRead: 200, cacheWrite: undefined }, 0),
		pricing,
	)
	// Reported cache reads exceed the folded total: the uncached term clamps to 0, reads still bill.
	expect(cost).toBeCloseTo((200 * 0.5) / 1_000_000, 10)
})
