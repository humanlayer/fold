/** @jsxImportSource @opentui/solid */
import { AgentId, LogEntry } from '@humanlayer/tart-core'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { Schema } from 'effect'

import { TuiApp } from '../../src/tui/App'
import { makeSessionStateFromEntries } from '../../src/tui/SessionState'

const rootAgentId = Schema.decodeUnknownSync(AgentId)('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
const resultMessageIds = [
	'msg_bbbbbbbbbbbbbbbbbbbbbbbb',
	'msg_cccccccccccccccccccccccc',
	'msg_dddddddddddddddddddddddd',
	'msg_eeeeeeeeeeeeeeeeeeeeeeee',
	'msg_ffffffffffffffffffffffff',
] as const
const calls = [
	{
		id: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
		name: 'read',
		params: { path: 'src/read.ts' },
		result: { content: [{ type: 'text', text: 'export const fullReadLine = true\nexport const secondLine = 2' }] },
	},
	{
		id: 'tool_call_bbbbbbbbbbbbbbbbbbbbbbbb',
		name: 'write',
		params: { path: 'src/created.ts', content: 'export const createdValue = 1\n' },
		result: { message: 'Successfully wrote 30 bytes to src/created.ts' },
	},
	{
		id: 'tool_call_cccccccccccccccccccccccc',
		name: 'edit',
		params: {
			path: 'src/edited.ts',
			edits: [{ oldText: 'const oldValue = 1', newText: 'const newValue = 2' }],
		},
		result: { message: 'Successfully replaced 1 block in src/edited.ts.' },
	},
	{
		id: 'tool_call_dddddddddddddddddddddddd',
		name: 'apply_patch',
		params: {
			patch_text: [
				'*** Begin Patch',
				'*** Update File: src/patched.ts',
				'@@',
				'-const beforePatch = 1',
				'+const afterPatch = 2',
				'*** End Patch',
			].join('\n'),
		},
		result: { message: 'Applied patch.\nUpdated: src/patched.ts' },
	},
	{
		id: 'tool_call_eeeeeeeeeeeeeeeeeeeeeeee',
		name: 'skill',
		params: { name: 'demo-skill' },
		result: {
			content: [
				'<skill name="demo-skill" baseDir="/tmp/demo-skill">',
				'Relative paths referenced by this skill (references/, scripts/, ...) resolve against /tmp/demo-skill.',
				'',
				'# Loaded Skill Heading',
				'',
				'Use **structured verification** for this task.',
				'</skill>',
			].join('\n'),
		},
	},
] as const

const entries = [
	Schema.decodeUnknownSync(LogEntry)({
		_tag: 'assistant-message',
		seq: 1,
		ts: 1,
		agentId: rootAgentId,
		parentAgentId: null,
		toolCallId: null,
		messageId: 'msg_aaaaaaaaaaaaaaaaaaaaaaaa',
		message: {
			role: 'assistant',
			content: [
				...calls.map((call) => ({
					type: 'tool-call' as const,
					id: call.id,
					name: call.name,
					params: call.params,
					providerExecuted: false,
				})),
				{ type: 'text' as const, text: 'Trailing assistant row keeps skill inspectable.' },
			],
		},
		finish: null,
	}),
	...calls.map((call, index) =>
		Schema.decodeUnknownSync(LogEntry)({
			_tag: 'tool-result',
			seq: index + 2,
			ts: index + 2,
			agentId: rootAgentId,
			parentAgentId: null,
			toolCallId: call.id,
			messageId: resultMessageIds[index],
			message: {
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						id: call.id,
						name: call.name,
						isFailure: false,
						result: call.result,
					},
				],
			},
		}),
	),
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
			sessionId="sess_tool_inspect"
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
