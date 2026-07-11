/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { createSignal } from 'solid-js'

import { TuiApp } from '../../src/tui/App'
import { rootInputVerbLabel } from '../../src/tui/Converse'
import { makeSessionState } from '../../src/tui/SessionState'

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
const [status, setStatus] = createSignal<'RUNNING' | 'IDLE' | 'STOPPED'>('IDLE')
const [notice, setNotice] = createSignal<string | null>(null)

await render(
	() => (
		<TuiApp
			state={() => ({ ...makeSessionState(null), status: status() })}
			cwd="/workspace/tart"
			sessionId="sess_terminal_control"
			mode="default"
			profile="default"
			notice={notice}
			onCompact={() => setNotice('COMPACTED')}
			onSubmit={(verb, text) => {
				setNotice(`${rootInputVerbLabel(verb)} RECEIVED · ${text.replaceAll('\n', ' / ')}`)
				setStatus('RUNNING')
			}}
			onInterrupt={() => {
				setNotice('INTERRUPT REQUESTED')
				setStatus('STOPPED')
			}}
			onCopySessionId={() => setNotice('SESSION ID COPIED')}
		/>
	),
	renderer,
)
renderer.start()
await destroyed
