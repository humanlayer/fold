import { AgentId, LogEntry, type TartEvent } from '@humanlayer/tart-core'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
	conversationRows,
	makeSessionState,
	makeSessionStateFromEntries,
	reduceSessionEvent,
	reduceSessionEvents,
} from '../../src/tui/SessionState'

const rootAgentId = Schema.decodeUnknownSync(AgentId)('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
const childAgentId = Schema.decodeUnknownSync(AgentId)('agent_bbbbbbbbbbbbbbbbbbbbbbbb')

const entry = (input: unknown) => Schema.decodeUnknownSync(LogEntry)(input)
const assistant = (seq: number, agentId = rootAgentId) =>
	entry({
		_tag: 'assistant-message',
		seq,
		ts: seq,
		agentId,
		parentAgentId: agentId === rootAgentId ? null : rootAgentId,
		toolCallId: agentId === rootAgentId ? null : 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
		messageId: `msg_${String(seq).padStart(24, 'a')}`,
		message: { role: 'assistant', content: [{ type: 'text', text: `message ${seq}` }] },
		finish: null,
	})

const delta = (type: 'text-delta' | 'reasoning-delta', id: string, text: string, agentId = rootAgentId): TartEvent => ({
	kind: 'delta',
	agentId,
	parentAgentId: agentId === rootAgentId ? null : rootAgentId,
	toolCallId: null,
	part: { type, id, delta: text },
})

describe('TUI session reducer', () => {
	it('deduplicates durable entries by seq and orders projected root content chronologically', () => {
		const second = assistant(2)
		const first = assistant(1)
		const state = reduceSessionEvents(
			makeSessionState(2),
			[
				{ kind: 'log', entry: second },
				{ kind: 'log', entry: first },
				{ kind: 'log', entry: second },
			],
			rootAgentId,
		)

		expect(state.seenSeqs).toEqual([2, 1])
		expect(state.rootContent.map(({ seq }) => seq)).toEqual([1, 2])
		expect(state.durableHead).toBe(2)
	})

	it('projects only root-agent content while still advancing the durable replay head', () => {
		const state = reduceSessionEvent(
			makeSessionState(3),
			{ kind: 'log', entry: assistant(3, childAgentId) },
			rootAgentId,
		)

		expect(state.rootContent).toEqual([])
		expect(state.seenSeqs).toEqual([3])
		expect(state.replay).toEqual({ _tag: 'ready', head: 3 })
	})

	it('does not let child lifecycle entries replace the root model or status', () => {
		const rootStarted = entry({
			_tag: 'agent_started',
			seq: 0,
			ts: 0,
			agentId: rootAgentId,
			parentAgentId: null,
			toolCallId: null,
			mode: 'fresh',
			model: {
				providerId: 'anthropic',
				providerKind: 'anthropic',
				modelId: 'root-model',
				role: null,
				requestedReasoningLevel: 'off',
				thinking: { _tag: 'disabled' },
			},
			tools: [],
			skill: null,
			fork: null,
			agentType: null,
		})
		const childStarted = entry({
			_tag: 'agent_started',
			seq: 1,
			ts: 1,
			agentId: childAgentId,
			parentAgentId: rootAgentId,
			toolCallId: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
			mode: 'fresh',
			model: {
				providerId: 'anthropic',
				providerKind: 'anthropic',
				modelId: 'child-model',
				role: null,
				requestedReasoningLevel: 'off',
				thinking: { _tag: 'disabled' },
			},
			tools: [],
			skill: null,
			fork: null,
			agentType: 'researcher',
		})
		const childFinished = entry({
			_tag: 'agent-finished',
			seq: 2,
			ts: 2,
			agentId: childAgentId,
			parentAgentId: rootAgentId,
			toolCallId: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
			outcome: 'completed',
			resultText: 'done',
			reason: null,
		})

		const running = reduceSessionEvent(
			reduceSessionEvents(
				makeSessionState(2),
				[rootStarted, childStarted].map((value) => ({ kind: 'log', entry: value })),
				rootAgentId,
			),
			delta('text-delta', 'root-part', 'working'),
			rootAgentId,
		)
		const finishedChild = reduceSessionEvent(running, { kind: 'log', entry: childFinished }, rootAgentId)

		expect(finishedChild.model).toBe('root-model')
		expect(finishedChild.status).toBe('RUNNING')
	})

	it('returns the root to idle after a completed run', () => {
		const completed = entry({
			_tag: 'agent-finished',
			seq: 0,
			ts: 0,
			agentId: rootAgentId,
			parentAgentId: null,
			toolCallId: null,
			outcome: 'completed',
			resultText: 'done',
			reason: null,
		})
		const running = reduceSessionEvent(
			makeSessionState(0),
			delta('text-delta', 'root-part', 'working'),
			rootAgentId,
		)

		expect(reduceSessionEvent(running, { kind: 'log', entry: completed }, rootAgentId).status).toBe('IDLE')
	})

	it('keeps root errors distinct from user-requested stops', () => {
		const failed = entry({
			_tag: 'agent-finished',
			seq: 0,
			ts: 0,
			agentId: rootAgentId,
			parentAgentId: null,
			toolCallId: null,
			outcome: 'error',
			resultText: null,
			reason: 'provider failed',
		})

		expect(reduceSessionEvent(makeSessionState(null), { kind: 'log', entry: failed }, rootAgentId).status).toBe(
			'ERROR',
		)
	})

	it('accumulates live text and reasoning independently under stable part keys', () => {
		const state = reduceSessionEvents(
			makeSessionState(null),
			[
				delta('text-delta', 'part-1', 'hel'),
				delta('reasoning-delta', 'part-1', 'why'),
				delta('text-delta', 'part-1', 'lo'),
				delta('text-delta', 'part-2', '!'),
				delta('text-delta', 'part-child', 'hidden', childAgentId),
			],
			rootAgentId,
		)

		expect(state.transientContent).toEqual([
			{ key: 'text:part-1', kind: 'text', text: 'hello' },
			{ key: 'reasoning:part-1', kind: 'reasoning', text: 'why' },
			{ key: 'text:part-2', kind: 'text', text: '!' },
		])
	})

	it('uses a durable root assistant message as canonical content and clears transient buffers', () => {
		const streaming = reduceSessionEvents(
			makeSessionState(4),
			[delta('reasoning-delta', 'reason', 'draft'), delta('text-delta', 'text', 'partial')],
			rootAgentId,
		)
		const durable = reduceSessionEvent(streaming, { kind: 'log', entry: assistant(4) }, rootAgentId)

		expect(durable.transientContent).toEqual([])
		expect(durable.rootContent).toHaveLength(1)
		expect(durable.replay).toEqual({ _tag: 'ready', head: 4 })
	})

	it('becomes ready when the supplied durable head arrives without requiring contiguous sequence numbers', () => {
		const waiting = reduceSessionEvent(makeSessionState(5), { kind: 'log', entry: assistant(4) }, rootAgentId)
		const ready = reduceSessionEvent(waiting, { kind: 'log', entry: assistant(5) }, rootAgentId)

		expect(waiting.replay).toEqual({ _tag: 'replaying', head: 5 })
		expect(ready.replay).toEqual({ _tag: 'ready', head: 5 })
		expect(makeSessionState(null).replay).toEqual({ _tag: 'ready', head: null })
	})

	it('projects an existing replay snapshot before the renderer mounts', () => {
		const state = makeSessionStateFromEntries([assistant(4), assistant(7)], rootAgentId)

		expect(state.rootContent.map(({ seq }) => seq)).toEqual([4, 7])
		expect(state.durableHead).toBe(7)
		expect(state.replay).toEqual({ _tag: 'ready', head: null })
	})

	it('folds tool results into their call row without exposing result contents', () => {
		const user = entry({
			_tag: 'user-message',
			seq: 1,
			ts: 1,
			agentId: rootAgentId,
			parentAgentId: null,
			toolCallId: null,
			messageId: 'msg_aaaaaaaaaaaaaaaaaaaaaaaa',
			message: { role: 'user', content: 'inspect the repository' },
		})
		const response = entry({
			_tag: 'assistant-message',
			seq: 2,
			ts: 2,
			agentId: rootAgentId,
			parentAgentId: null,
			toolCallId: null,
			messageId: 'msg_bbbbbbbbbbbbbbbbbbbbbbbb',
			message: {
				role: 'assistant',
				content: [
					{ type: 'reasoning', text: 'I should inspect the package tree.' },
					{ type: 'text', text: 'I will inspect it now.' },
					{
						type: 'tool-call',
						id: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
						name: 'bash',
						params: { command: 'ls packages' },
						providerExecuted: false,
					},
				],
			},
			finish: null,
		})
		const result = entry({
			_tag: 'tool-result',
			seq: 3,
			ts: 3,
			agentId: rootAgentId,
			parentAgentId: null,
			toolCallId: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
			messageId: 'msg_cccccccccccccccccccccccc',
			message: {
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						id: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
						name: 'bash',
						isFailure: false,
						result: { output: 'tart-cli\ntart-core' },
					},
				],
			},
		})

		const rows = conversationRows(makeSessionStateFromEntries([user, response, result], rootAgentId))

		expect(rows.map(({ kind, label }) => ({ kind, label }))).toEqual([
			{ kind: 'user', label: 'USER' },
			{ kind: 'reasoning', label: 'THINKING' },
			{ kind: 'assistant', label: 'ASSISTANT' },
			{ kind: 'tool-call', label: 'BASH' },
		])
		expect(rows.at(-1)).toMatchObject({ kind: 'tool-call', status: 'done', isFailure: false })
		expect(rows.some(({ text }) => text.includes('tart-cli'))).toBe(false)
	})

	it('marks flushed assistant text as partial after interruption', () => {
		const partial = assistant(1)
		const interrupted = entry({
			_tag: 'agent-finished',
			seq: 2,
			ts: 2,
			agentId: rootAgentId,
			parentAgentId: null,
			toolCallId: null,
			outcome: 'interrupted',
			resultText: null,
			reason: 'interrupted by the user',
		})

		const state = makeSessionStateFromEntries([partial, interrupted], rootAgentId)

		expect(state.status).toBe('STOPPED')
		expect(conversationRows(state)).toEqual([
			expect.objectContaining({ kind: 'assistant', label: 'PARTIAL', status: 'partial', text: 'message 1' }),
		])
	})

	it('renders synthetic interrupted tool results as interrupted instead of failed', () => {
		const response = entry({
			_tag: 'assistant-message',
			seq: 1,
			ts: 1,
			agentId: rootAgentId,
			parentAgentId: null,
			toolCallId: null,
			messageId: 'msg_dddddddddddddddddddddddd',
			message: {
				role: 'assistant',
				content: [
					{
						type: 'tool-call',
						id: 'tool_call_bbbbbbbbbbbbbbbbbbbbbbbb',
						name: 'bash',
						params: { command: 'sleep 10' },
						providerExecuted: false,
					},
				],
			},
			finish: null,
		})
		const result = entry({
			_tag: 'tool-result',
			seq: 2,
			ts: 2,
			agentId: rootAgentId,
			parentAgentId: null,
			toolCallId: 'tool_call_bbbbbbbbbbbbbbbbbbbbbbbb',
			messageId: 'msg_eeeeeeeeeeeeeeeeeeeeeeee',
			message: {
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						id: 'tool_call_bbbbbbbbbbbbbbbbbbbbbbbb',
						name: 'bash',
						isFailure: true,
						result: '<system-information>The user interrupted the execution of this tool call.</system-information>',
					},
				],
			},
		})

		expect(conversationRows(makeSessionStateFromEntries([response, result], rootAgentId))).toEqual([
			expect.objectContaining({ kind: 'tool-call', status: 'interrupted', isFailure: true }),
		])
	})

	it('is deterministic for the same initial state and events', () => {
		const events = [
			delta('text-delta', 'part', 'one'),
			{ kind: 'log', entry: assistant(1) },
		] satisfies ReadonlyArray<TartEvent>

		expect(reduceSessionEvents(makeSessionState(1), events, rootAgentId)).toEqual(
			reduceSessionEvents(makeSessionState(1), events, rootAgentId),
		)
	})
})
