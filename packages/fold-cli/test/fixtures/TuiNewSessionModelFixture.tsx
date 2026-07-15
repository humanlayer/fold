/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { createSignal, Show } from 'solid-js'

import { NewSessionModal } from '../../src/tui/NewSessionModal'

const configuration = {
	profiles: [{ name: 'fixture-profile', mode: 'rlm' as const }],
	providers: [
		{
			name: 'fixture-provider',
			kind: 'anthropic' as const,
			apiKeyEnv: null,
			credentialPresent: true,
			models: ['fixture-model'],
		},
	],
}

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
const [result, setResult] = createSignal<string | null>(null)

await render(
	() => (
		<box flexDirection="column">
			<Show when={result() === null} fallback={<text>{result()}</text>}>
				<NewSessionModal
					cwd="/tmp"
					configuration={configuration}
					onClose={() => renderer.destroy()}
					onSubmit={(request) => setResult(JSON.stringify(request))}
				/>
			</Show>
		</box>
	),
	renderer,
)
renderer.start()
await destroyed
