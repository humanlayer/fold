/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'

import { TuiApp } from '../../src/tui/App'
import { makeSessionState } from '../../src/tui/SessionState'

let resolveDestroyed: (() => void) | undefined
const destroyed = new Promise<void>((resolve) => {
	resolveDestroyed = resolve
})
const renderer = await createCliRenderer({
	targetFps: 30,
	exitOnCtrlC: false,
	consoleMode: 'disabled',
	onDestroy: () => resolveDestroyed?.(),
})

await render(
	() => (
		<TuiApp
			state={() => makeSessionState(null)}
			cwd="/workspace/tart"
			sessionId="sess_terminal_control"
			mode="default"
			profile="default"
			onInterrupt={() => undefined}
		/>
	),
	renderer,
)
renderer.start()
await destroyed
