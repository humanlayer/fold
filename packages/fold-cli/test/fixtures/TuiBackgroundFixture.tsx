/** @jsxImportSource @opentui/solid */
/**
 * Fixture for background subagents in the TUI: one running and one finished background agent, and a
 * task-notification wake in the root transcript. `x` on the selected running agent records it stopped.
 */
import { AgentId, EventId, LogEntry } from '@humanlayer/fold-core'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { Schema } from 'effect'
import { createSignal } from 'solid-js'

import { TuiApp } from '../../src/tui/App'
import { makeSessionStateFromEntries } from '../../src/tui/SessionState'

const rootAgentId = Schema.decodeSync(AgentId)('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
const loaderAgentId = Schema.decodeSync(AgentId)('agent_bbbbbbbbbbbbbbbbbbbbbbbb')
const auditAgentId = Schema.decodeSync(AgentId)('agent_cccccccccccccccccccccccc')
const loaderCall = 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa'
const auditCall = 'tool_call_bbbbbbbbbbbbbbbbbbbbbbbb'
const model = {
	providerId: 'anthropic',
	providerKind: 'anthropic',
	modelId: 'fixture-model',
	role: null,
	requestedReasoningLevel: 'off',
	thinking: { _tag: 'disabled' },
}
const entry = (input: Record<string, unknown>) =>
	Schema.decodeUnknownSync(LogEntry)({ ...input, eventId: EventId.create(), version: 1 })
const root = { agentId: rootAgentId, parentAgentId: null, toolCallId: null }
const started = (seq: number, agentId: string, toolCallId: string, agentType: string, description: string) => [
	entry({
		_tag: 'agent_started',
		seq,
		ts: Date.now(),
		agentId,
		parentAgentId: rootAgentId,
		toolCallId,
		mode: 'fresh',
		model,
		tools: [],
		skill: null,
		fork: null,
		agentType,
	}),
	entry({
		_tag: 'task_started',
		seq: seq + 1,
		ts: Date.now(),
		agentId,
		parentAgentId: rootAgentId,
		toolCallId,
		taskType: 'subagent',
		agentType,
		description,
		prompt: description,
		isBackgrounded: true,
		runCount: 1,
	}),
]
const taskFinished = (seq: number, agentId: string, toolCallId: string, status: string) =>
	entry({
		_tag: 'task_finished',
		seq,
		ts: Date.now(),
		agentId,
		parentAgentId: rootAgentId,
		toolCallId,
		status,
		summary: status === 'completed' ? 'tests look fine' : null,
		error: null,
		usage: { turns: 1, toolUses: 0, totalTokens: null },
		durationMs: 10,
		lastToolName: null,
	})

const initial = [
	entry({
		_tag: 'agent_started',
		seq: 0,
		ts: 0,
		...root,
		mode: 'fresh',
		model,
		tools: ['subagent'],
		skill: null,
		fork: null,
		agentType: null,
	}),
	entry({
		_tag: 'user-message',
		seq: 1,
		ts: 1,
		...root,
		messageId: 'msg_aaaaaaaaaaaaaaaaaaaaaaaa',
		message: { role: 'user', content: 'Investigate two things.' },
	}),
	entry({
		_tag: 'assistant-message',
		seq: 2,
		ts: 2,
		...root,
		messageId: 'msg_bbbbbbbbbbbbbbbbbbbbbbbb',
		message: {
			role: 'assistant',
			content: [
				{
					type: 'tool-call',
					id: loaderCall,
					name: 'subagent',
					params: {
						agent: 'researcher',
						description: 'find the config loader',
						prompt: 'find it',
						run_in_background: true,
					},
					providerExecuted: false,
				},
				{
					type: 'tool-call',
					id: auditCall,
					name: 'subagent',
					params: {
						agent: 'general-purpose',
						description: 'audit the tests',
						prompt: 'audit',
						run_in_background: true,
					},
					providerExecuted: false,
				},
			],
		},
		finish: null,
	}),
	...started(3, loaderAgentId, loaderCall, 'researcher', 'find the config loader'),
	...started(5, auditAgentId, auditCall, 'general-purpose', 'audit the tests'),
	entry({
		_tag: 'assistant-message',
		seq: 7,
		ts: 7,
		...root,
		messageId: 'msg_cccccccccccccccccccccccc',
		message: { role: 'assistant', content: [{ type: 'text', text: 'Started two background agents.' }] },
		finish: null,
	}),
	entry({
		_tag: 'agent-finished',
		seq: 8,
		ts: 8,
		...root,
		outcome: 'completed',
		resultText: 'Started two background agents.',
		reason: null,
	}),
	entry({
		_tag: 'agent-finished',
		seq: 9,
		ts: 9,
		agentId: auditAgentId,
		parentAgentId: rootAgentId,
		toolCallId: auditCall,
		outcome: 'completed',
		resultText: 'tests look fine',
		reason: null,
	}),
	taskFinished(10, auditAgentId, auditCall, 'completed'),
	entry({
		_tag: 'user-message',
		seq: 11,
		ts: 11,
		...root,
		messageId: 'msg_dddddddddddddddddddddddd',
		message: {
			role: 'user',
			content:
				'<task-notification>\n<summary>Background agent "audit the tests" completed</summary>\n</task-notification>',
		},
		origin: { _tag: 'task-notification', taskIds: [auditAgentId] },
	}),
	entry({
		_tag: 'assistant-message',
		seq: 12,
		ts: 12,
		...root,
		messageId: 'msg_eeeeeeeeeeeeeeeeeeeeeeee',
		message: { role: 'assistant', content: [{ type: 'text', text: 'The test audit is done.' }] },
		finish: null,
	}),
	entry({
		_tag: 'agent-finished',
		seq: 13,
		ts: 13,
		...root,
		outcome: 'completed',
		resultText: 'The test audit is done.',
		reason: null,
	}),
]

const [entries, setEntries] = createSignal<ReadonlyArray<LogEntry>>(initial)
const [targetNotice, setTargetNotice] = createSignal<{ readonly agentId: string; readonly text: string } | null>(null)

let resolveDestroyed: (() => void) | undefined
const destroyed = new Promise<void>((resolve) => {
	resolveDestroyed = resolve
})
const renderer = await createCliRenderer({
	targetFps: 30,
	exitOnCtrlC: false,
	consoleMode: 'disabled',
	useKittyKeyboard: {},
	onDestroy: () => resolveDestroyed?.(),
})

await render(
	() => (
		<TuiApp
			state={() => makeSessionStateFromEntries(entries(), rootAgentId)}
			cwd="/workspace/fold"
			sessionId="sess_background"
			mode="default"
			profile="default"
			notice={() => null}
			targetNotice={targetNotice}
			onCompact={() => undefined}
			onSubmit={() => undefined}
			onInterrupt={() => undefined}
			onStopTask={(agentId) => {
				setTargetNotice({ agentId, text: 'BACKGROUND AGENT STOPPED' })
				setEntries((current) => [
					...current,
					entry({
						_tag: 'agent-finished',
						seq: 14,
						ts: 14,
						agentId,
						parentAgentId: rootAgentId,
						toolCallId: loaderCall,
						outcome: 'interrupted',
						resultText: null,
						reason: 'interrupted by the user',
					}),
					taskFinished(15, agentId, loaderCall, 'stopped'),
				])
			}}
		/>
	),
	renderer,
)
renderer.start()
await destroyed
