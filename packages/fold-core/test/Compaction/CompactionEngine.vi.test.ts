/**
 * Pure engine tests for auto-compaction (D11): the usage fold, the interim context-window table and
 * threshold arithmetic, the stale-usage/progress guard in `latestReportedContextTokens`, cut-point
 * selection (never on a tool-result), transcript serialization, and overflow-error classification.
 */
import { expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import {
	compactionUsableTokens,
	contextTokensFromUsage,
	defaultContextWindowFor,
	estimateMessageTokens,
	findCompactionCut,
	isContextOverflowError,
	latestReportedContextTokens,
	serializeConversation,
	AgentId,
	CompactionId,
	MessageId,
	ToolCallId,
	type AssistantMessageLogEntry,
	type CompactionLogEntry,
	type LogEntry,
	type ProjectedMessage,
	type UsageEncoded,
} from '../../src/index'

const encodeUser = Schema.encodeUnknownSync(Prompt.UserMessage)
const encodeAssistant = Schema.encodeUnknownSync(Prompt.AssistantMessage)
const encodeTool = Schema.encodeUnknownSync(Prompt.ToolMessage)

const agentId = AgentId.create()

const usage = (input: number, output: number): UsageEncoded => ({
	inputTokens: { uncached: undefined, total: input, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: output, text: undefined, reasoning: undefined },
})

// ── Projected message fixtures ───────────────────────────────────────────────

const userMessage = (sourceSeq: number, text: string): ProjectedMessage => ({
	_tag: 'user-message',
	sourceSeq,
	messageId: MessageId.create(),
	message: encodeUser(Prompt.userMessage({ content: [Prompt.textPart({ text })] })),
})

const assistantText = (sourceSeq: number, text: string): ProjectedMessage => ({
	_tag: 'assistant-message',
	sourceSeq,
	messageId: MessageId.create(),
	message: encodeAssistant(Prompt.assistantMessage({ content: [Prompt.textPart({ text })] })),
	finish: null,
})

const assistantToolCall = (sourceSeq: number, name: string, params: unknown): ProjectedMessage => ({
	_tag: 'assistant-message',
	sourceSeq,
	messageId: MessageId.create(),
	message: encodeAssistant(
		Prompt.assistantMessage({
			content: [Prompt.toolCallPart({ id: `call-${sourceSeq}`, name, params, providerExecuted: false })],
		}),
	),
	finish: null,
})

const toolResult = (sourceSeq: number, result: unknown): ProjectedMessage => ({
	_tag: 'tool-result',
	sourceSeq,
	toolCallId: ToolCallId.create(),
	messageId: MessageId.create(),
	message: encodeTool(
		Prompt.toolMessage({
			content: [Prompt.toolResultPart({ id: `call-${sourceSeq}`, name: 'echo', isFailure: false, result })],
		}),
	),
})

// ── Log entry fixtures ───────────────────────────────────────────────────────

const assistantEntry = (seq: number, finishUsage: UsageEncoded | null): AssistantMessageLogEntry => ({
	_tag: 'assistant-message',
	seq,
	ts: 0,
	agentId,
	parentAgentId: null,
	toolCallId: null,
	messageId: MessageId.create(),
	message: encodeAssistant(Prompt.assistantMessage({ content: [Prompt.textPart({ text: 'reply' })] })),
	finish: finishUsage === null ? null : { reason: 'stop', usage: finishUsage },
})

const compactionEntry = (seq: number, replacesThroughSeq: number): CompactionLogEntry => ({
	_tag: 'compaction',
	seq,
	ts: 0,
	agentId,
	parentAgentId: null,
	toolCallId: null,
	compactionId: CompactionId.create(),
	summary: 'a summary',
	replacesThroughSeq,
	tokensBefore: 0,
})

// ── Usage folding and thresholds ─────────────────────────────────────────────

it('contextTokensFromUsage sums total input (cache included by providers) and output', () => {
	expect(contextTokensFromUsage(usage(7000, 500))).toBe(7500)

	// Falls back to summing the parts when the provider omitted the input total.
	expect(
		contextTokensFromUsage({
			inputTokens: { uncached: 1000, total: undefined, cacheRead: 2000, cacheWrite: 500 },
			outputTokens: { total: 100, text: undefined, reasoning: undefined },
		}),
	).toBe(3600)

	// Nothing reported means nothing to compare against.
	expect(
		contextTokensFromUsage({
			inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: undefined, text: undefined, reasoning: undefined },
		}),
	).toBeNull()
})

it('defaultContextWindowFor uses the interim table with a conservative fallback', () => {
	expect(defaultContextWindowFor('claude-opus-4-8')).toBe(200_000)
	expect(defaultContextWindowFor('claude-fable-5')).toBe(200_000)
	expect(defaultContextWindowFor('gpt-5.5')).toBe(272_000)
	expect(defaultContextWindowFor('gpt-5.3-codex')).toBe(272_000)
	expect(defaultContextWindowFor('some-unknown-model')).toBe(128_000)
	expect(defaultContextWindowFor(null)).toBe(128_000)
})

it('compactionUsableTokens applies the D11 formula, clamped for tiny windows', () => {
	// 200k window: 200000 - 32000 (output budget) - 16384 (reserve) = 151616.
	expect(compactionUsableTokens({ contextWindow: 200_000, reserveTokens: 16_384 })).toBe(151_616)
	// Tiny windows clamp the output budget to window/4 and the reserve to window/8, staying positive.
	expect(compactionUsableTokens({ contextWindow: 2_000, reserveTokens: 16_384 })).toBe(1_250)
})

// ── Stale-usage / progress guard ─────────────────────────────────────────────

it('latestReportedContextTokens ignores usage recorded before the latest compaction', () => {
	const entries: ReadonlyArray<LogEntry> = [
		assistantEntry(1, usage(7000, 100)),
		compactionEntry(2, 1),
		assistantEntry(3, null),
	]

	// The huge pre-compaction usage measured the OLD context; with no post-compaction usage yet,
	// there is nothing trustworthy - which is exactly the never-compact-twice-without-progress guard.
	expect(latestReportedContextTokens(entries)).toBeNull()

	// A fresh post-compaction response reports honestly again.
	expect(latestReportedContextTokens([...entries, assistantEntry(4, usage(3000, 50))])).toBe(3050)
})

it('latestReportedContextTokens reads the newest reported usage when no compaction exists', () => {
	expect(latestReportedContextTokens([assistantEntry(1, usage(100, 10)), assistantEntry(2, usage(200, 20))])).toBe(
		220,
	)
	expect(latestReportedContextTokens([assistantEntry(1, null)])).toBeNull()
	expect(latestReportedContextTokens([])).toBeNull()
})

// ── Cut-point selection ──────────────────────────────────────────────────────

it('findCompactionCut keeps everything when the conversation fits the keep budget', () => {
	const messages = [userMessage(1, 'hi'), assistantText(2, 'hello')]

	expect(findCompactionCut(messages, 20_000)).toBe(0)
})

it('findCompactionCut summarizes the prefix and keeps a recent tail', () => {
	const messages = [
		userMessage(1, 'old topic to be summarized'),
		assistantText(2, 'old answer'),
		userMessage(3, 'newer question'),
		assistantText(4, 'p'.repeat(120)), // ~30 tokens: crosses a keep budget of 10 here
		userMessage(5, 'newest question'),
	]

	const cut = findCompactionCut(messages, 10)
	expect(cut).toBe(3)
	// Everything before the cut is summarized; the cut message opens the kept tail.
	expect(messages.slice(cut)[0]?.sourceSeq).toBe(4)
})

it('findCompactionCut never lands on a tool-result: the owning assistant stays with its results', () => {
	const messages = [
		userMessage(1, 'do the thing with a big payload'),
		assistantToolCall(2, 'echo', { text: 'x'.repeat(100) }),
		toolResult(3, { echoed: 'x'.repeat(100) }),
	]

	// The keep budget is crossed inside the tool result, but the cut slides to the assistant that
	// owns it - a tool result never opens the kept region without its tool call.
	const cut = findCompactionCut(messages, 10)
	expect(cut).toBe(1)
	expect(messages[cut]?._tag).toBe('assistant-message')
})

it('findCompactionCut returns 0 when no coherent cut exists', () => {
	// A single oversized user message: the budget is crossed at index 0, so nothing can be summarized.
	expect(findCompactionCut([userMessage(1, 'y'.repeat(400))], 10)).toBe(0)
	expect(findCompactionCut([], 10)).toBe(0)
})

// ── Transcript serialization ─────────────────────────────────────────────────

it('serializeConversation flattens messages into the pi transcript shape', () => {
	const messages = [
		userMessage(1, 'fix the flaky test'),
		assistantToolCall(2, 'read', { path: 'ci.yml' }),
		toolResult(3, { content: 'file contents' }),
		assistantText(4, 'The race is in ci.yml.'),
	]

	const serialized = serializeConversation(messages)
	expect(serialized).toContain('[User]: fix the flaky test')
	expect(serialized).toContain('[Assistant tool calls]: read({"path":"ci.yml"})')
	expect(serialized).toContain('[Tool result]: {"content":"file contents"}')
	expect(serialized).toContain('[Assistant]: The race is in ci.yml.')
})

it('serializeConversation truncates huge tool results so the summarizer request stays bounded', () => {
	const serialized = serializeConversation([toolResult(1, { blob: 'z'.repeat(5_000) })])

	expect(serialized.length).toBeLessThan(2_200)
	expect(serialized).toContain('more characters truncated]')
})

it('estimateMessageTokens weighs text by chars/4 and never returns zero', () => {
	expect(estimateMessageTokens(userMessage(1, 'x'.repeat(400)))).toBe(100)
	expect(estimateMessageTokens(userMessage(1, ''))).toBe(1)
})

// ── Overflow classification ──────────────────────────────────────────────────

it('isContextOverflowError recognizes provider overflow messages and rejects the rest', () => {
	expect(isContextOverflowError('400 context_length_exceeded: reduce your prompt')).toBe(true)
	expect(isContextOverflowError('prompt is too long: 210000 tokens > 200000 maximum')).toBe(true)
	expect(isContextOverflowError('413 Request Entity Too Large')).toBe(true)
	expect(isContextOverflowError('input is too long for requested model')).toBe(true)

	expect(isContextOverflowError('rate limit exceeded, try again later')).toBe(false)
	expect(isContextOverflowError('boom')).toBe(false)
	// The negative guard wins even when an overflow-looking word appears.
	expect(isContextOverflowError('quota exceeded: maximum context length purchases require billing')).toBe(false)
})
