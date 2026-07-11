/** @jsxImportSource @opentui/solid */
import { AgentId, LogEntry } from '@humanlayer/tart-core'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { Schema } from 'effect'

import { TuiApp } from '../../src/tui/App'
import { makeSessionStateFromEntries } from '../../src/tui/SessionState'

const rootAgentId = Schema.decodeUnknownSync(AgentId)('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
const entries = [
	Schema.decodeUnknownSync(LogEntry)({
		_tag: 'user-message',
		seq: 1,
		ts: 1,
		agentId: rootAgentId,
		parentAgentId: null,
		toolCallId: null,
		messageId: 'msg_aaaaaaaaaaaaaaaaaaaaaaaa',
		message: {
			role: 'user',
			content: ['User asks for **bold input** and code:', '', '```ts', 'const userPrompt = true', '```'].join(
				'\n',
			),
		},
	}),
	Schema.decodeUnknownSync(LogEntry)({
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
				{ type: 'reasoning', text: 'Thinking with _emphasis_ before answering.' },
				{
					type: 'tool-call',
					id: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
					name: 'bash',
					params: { command: 'pwd' },
					providerExecuted: false,
				},
				{
					type: 'text',
					text: [
						'Assistant returns **bold response** and `inlineCode()`.',
						'',
						'Second paragraph after a blank line.',
						'',
						'- themed first item',
						'- themed second item',
					].join('\n'),
				},
			],
		},
		finish: null,
	}),
	Schema.decodeUnknownSync(LogEntry)({
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
					result: { output: '/workspace/tart' },
				},
			],
		},
	}),
]
const state = makeSessionStateFromEntries(entries, rootAgentId)

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
			state={() => state}
			cwd="/workspace/tart"
			sessionId="sess_markdown"
			mode="default"
			profile="default"
			notice={() => null}
			onCompact={() => undefined}
			onSubmit={() => undefined}
			onInterrupt={() => undefined}
			onCopySessionId={() => undefined}
		/>
	),
	renderer,
)
renderer.start()
await destroyed
