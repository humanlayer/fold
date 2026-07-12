/** @jsxImportSource @opentui/solid */
import { AgentId, LogEntry } from '@humanlayer/tart-core'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { Schema } from 'effect'

import { TuiApp } from '../../src/tui/App'
import { makeSessionStateFromEntries } from '../../src/tui/SessionState'

const rootAgentId = Schema.decodeUnknownSync(AgentId)('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
const entry = (input: unknown) => Schema.decodeUnknownSync(LogEntry)(input)
const entries = [
	entry({
		_tag: 'user-message',
		seq: 0,
		ts: 0,
		agentId: rootAgentId,
		parentAgentId: null,
		toolCallId: null,
		messageId: 'msg_aaaaaaaaaaaaaaaaaaaaaaaa',
		message: { role: 'user', content: 'Explain the interruption.' },
	}),
	entry({
		_tag: 'assistant-message',
		seq: 1,
		ts: 1,
		agentId: rootAgentId,
		parentAgentId: null,
		toolCallId: null,
		messageId: 'msg_bbbbbbbbbbbbbbbbbbbbbbbb',
		message: { role: 'assistant', content: [{ type: 'text', text: 'This response stopped midway' }] },
		finish: null,
	}),
	entry({
		_tag: 'agent-finished',
		seq: 2,
		ts: 2,
		agentId: rootAgentId,
		parentAgentId: null,
		toolCallId: null,
		outcome: 'interrupted',
		resultText: null,
		reason: 'interrupted by the user',
	}),
	entry({
		_tag: 'user-message',
		seq: 3,
		ts: 3,
		agentId: rootAgentId,
		parentAgentId: null,
		toolCallId: null,
		messageId: 'msg_cccccccccccccccccccccccc',
		message: { role: 'user', content: 'Run the long command.' },
	}),
	entry({
		_tag: 'assistant-message',
		seq: 4,
		ts: 4,
		agentId: rootAgentId,
		parentAgentId: null,
		toolCallId: null,
		messageId: 'msg_dddddddddddddddddddddddd',
		message: {
			role: 'assistant',
			content: [
				{
					type: 'tool-call',
					id: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
					name: 'bash',
					params: { command: 'sleep 10' },
					providerExecuted: false,
				},
			],
		},
		finish: null,
	}),
	entry({
		_tag: 'tool-result',
		seq: 5,
		ts: 5,
		agentId: rootAgentId,
		parentAgentId: null,
		toolCallId: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
		messageId: 'msg_eeeeeeeeeeeeeeeeeeeeeeee',
		message: {
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					id: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
					name: 'bash',
					isFailure: true,
					result: '<system-information>The user interrupted the execution of this tool call.</system-information>',
				},
			],
		},
	}),
	entry({
		_tag: 'agent-finished',
		seq: 6,
		ts: 6,
		agentId: rootAgentId,
		parentAgentId: null,
		toolCallId: null,
		outcome: 'interrupted',
		resultText: null,
		reason: 'interrupted by the user',
	}),
]

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
			state={() => makeSessionStateFromEntries(entries, rootAgentId)}
			cwd="/workspace/tart"
			sessionId="sess_interrupted"
			mode="default"
			profile="default"
			notice={() => null}
			onCompact={() => undefined}
			onSubmit={() => undefined}
			onInterrupt={() => undefined}
		/>
	),
	renderer,
)
renderer.start()
await destroyed
