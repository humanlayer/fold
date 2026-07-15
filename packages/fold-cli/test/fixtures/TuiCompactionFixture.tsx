/** @jsxImportSource @opentui/solid */
import { AgentId, LogEntry } from '@humanlayer/fold-core'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { Schema } from 'effect'
import { createSignal } from 'solid-js'

import { TuiApp } from '../../src/tui/App'
import { makeSessionStateFromEntries } from '../../src/tui/SessionState'

const rootAgentId = Schema.decodeUnknownSync(AgentId)('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
const initialEntries = [
	Schema.decodeUnknownSync(LogEntry)({
		_tag: 'user-message',
		seq: 1,
		ts: 1,
		agentId: rootAgentId,
		parentAgentId: null,
		toolCallId: null,
		messageId: 'msg_aaaaaaaaaaaaaaaaaaaaaaaa',
		message: { role: 'user', content: 'Build the compaction view.' },
	}),
]
const compactedEntries = [
	...initialEntries,
	Schema.decodeUnknownSync(LogEntry)({
		_tag: 'compaction',
		seq: 2,
		ts: 2,
		agentId: rootAgentId,
		parentAgentId: null,
		toolCallId: null,
		compactionId: 'compaction_aaaaaaaaaaaaaaaaaaaaaaaa',
		prompt: 'Create a structured context checkpoint summary.',
		summary: '# Goal\n\nPreserve the compaction context.\n\n## Next Steps\n\n1. Continue the TUI work.',
		postCompactionInstructions: 'Use the archive tool to recover replaced details.',
		replacesThroughSeq: 1,
		tokensBefore: 1234,
	}),
	Schema.decodeUnknownSync(LogEntry)({
		_tag: 'assistant-message',
		seq: 3,
		ts: 3,
		agentId: rootAgentId,
		parentAgentId: null,
		toolCallId: null,
		messageId: 'msg_bbbbbbbbbbbbbbbbbbbbbbbb',
		message: { role: 'assistant', content: 'Ready after compaction.' },
		finish: null,
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
const [entries, setEntries] = createSignal(initialEntries)
const [notice, setNotice] = createSignal<string | null>(null)
const [compacting, setCompacting] = createSignal(false)

await render(
	() => (
		<TuiApp
			state={() => makeSessionStateFromEntries(entries(), rootAgentId)}
			cwd="/workspace/fold"
			sessionId="sess_compaction"
			mode="default"
			profile="default"
			notice={notice}
			compacting={compacting}
			onCompact={() => {
				setCompacting(true)
				setTimeout(() => {
					setEntries(compactedEntries)
					setNotice('COMPACTED')
					setCompacting(false)
				}, 2_000)
			}}
			onSubmit={(_verb, text) => setNotice(`AGENT RECEIVED · ${text}`)}
			onInterrupt={() => undefined}
		/>
	),
	renderer,
)
renderer.start()
await destroyed
