/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { createSignal } from 'solid-js'

import { SessionPicker } from '../../src/tui/SessionPicker'

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
const [notice] = createSignal<string | null>(null)
const [sessions] = createSignal([])

await render(
	() => (
		<SessionPicker
			cwd={process.cwd()}
			mode="default"
			profile="default"
			configExists
			configuration={{
				profiles: [],
				providers: [
					{
						name: 'fixture-xai',
						kind: 'xai',
						baseUrl: 'https://api.x.ai/v1',
						apiKeyEnv: null,
						credentialPresent: null,
						models: ['grok-4'],
					},
				],
			}}
			sessions={sessions}
			notice={notice}
			opening={() => false}
			onOpen={() => {}}
			onDelete={() => {}}
			onNew={() => {}}
			onProviderAuth={(provider, action, update) =>
				update({
					_tag: 'success',
					message: `AUTH UPDATED: ${provider} ${action}`,
				})
			}
			onInitializeConfig={() => {}}
			onConfigureProvider={() => {}}
			onQuit={() => renderer.destroy()}
		/>
	),
	renderer,
)
renderer.start()
await destroyed
