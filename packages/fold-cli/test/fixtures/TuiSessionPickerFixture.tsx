/** @jsxImportSource @opentui/solid */
import { SessionId } from '@humanlayer/fold-core'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { Schema } from 'effect'
import { createSignal } from 'solid-js'

import { SessionPicker } from '../../src/tui/SessionPicker'

const firstId = Schema.decodeUnknownSync(SessionId)('sess_abcdefghijklmnopqrstuvwx')
const secondId = Schema.decodeUnknownSync(SessionId)('sess_bcdefghijklmnopqrstuvwxy')
const initialSessions = [
	{
		sessionId: firstId,
		path: '/tmp/first.jsonl',
		mtimeMs: Date.now() - 2 * 60 * 60_000,
		title: 'Fix the flaky CI matrix',
		status: 'running' as const,
		turns: 8,
		providerId: 'anthropic',
		modelId: 'claude-opus-4-8',
		model: null,
		contextTokens: 84_000,
		contextPercent: 42,
		mode: 'rlm',
		rpi: true,
		profile: 'ultracodex',
	},
	{
		sessionId: secondId,
		path: '/tmp/second.jsonl',
		mtimeMs: Date.now() - 3 * 24 * 60 * 60_000,
		title: 'Port the Codex provider',
		status: 'ready' as const,
		turns: 12,
		providerId: 'codex',
		modelId: 'gpt-5.6-sol',
		model: null,
		contextTokens: 120_000,
		contextPercent: 59,
		mode: 'default',
		rpi: false,
		profile: 'default',
	},
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
const [notice, setNotice] = createSignal<string | null>(null)
const [sessions, setSessions] = createSignal(initialSessions)

await render(
	() => (
		<SessionPicker
			cwd={process.cwd()}
			mode="rlm+rpi"
			profile="ultracodex"
			configuration={{ profiles: [{ name: 'default', mode: null }], providers: [] }}
			sessions={sessions}
			notice={notice}
			opening={() => false}
			onOpen={(sessionId) => setNotice(`OPENED ${sessionId}`)}
			onDelete={(sessionId) => {
				setSessions((current) => current.filter((session) => session.sessionId !== sessionId))
				setNotice(`DELETED ${sessionId}`)
			}}
			onNew={() => setNotice('NEW SESSION SELECTED')}
			onQuit={() => renderer.destroy()}
		/>
	),
	renderer,
)
renderer.start()
await destroyed
