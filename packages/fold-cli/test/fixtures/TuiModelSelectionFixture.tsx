/** @jsxImportSource @opentui/solid */
import { createCliRenderer, type KeyEvent } from '@opentui/core'
import { render, useKeyboard } from '@opentui/solid'
import { createSignal, Show } from 'solid-js'

import { ModelSelectionModal } from '../../src/tui/ModelSelectionModal'

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
const [phase, setPhase] = createSignal<'profile' | 'direct' | 'active'>('profile')
const [notice, setNotice] = createSignal('READY')
const [activeOpen, setActiveOpen] = createSignal(false)

const Fixture = () => {
	useKeyboard((key: KeyEvent) => {
		if (key.eventType !== 'release' && key.ctrl && key.name === 'k' && phase() === 'active') {
			key.preventDefault()
			setActiveOpen(true)
		}
	})
	return (
		<box flexDirection="column">
			<text>{notice()}</text>
			<Show when={phase() === 'profile'}>
				<ModelSelectionModal
					configuration={configuration}
					context="new-session"
					onClose={() => renderer.destroy()}
					onSubmit={(request) => {
						setNotice(`CHOSEN ${JSON.stringify({ cwd: '/tmp', ...request })}`)
						setPhase('direct')
					}}
				/>
			</Show>
			<Show when={phase() === 'direct'}>
				<ModelSelectionModal
					configuration={configuration}
					context="new-session"
					onClose={() => renderer.destroy()}
					onSubmit={(request) => {
						setNotice(`CHOSEN ${JSON.stringify({ cwd: '/tmp', ...request })}`)
						setPhase('active')
					}}
				/>
			</Show>
			<Show when={phase() === 'active' && !activeOpen()}>
				<text>ACTIVE · CTRL-K</text>
			</Show>
			<Show when={activeOpen()}>
				<ModelSelectionModal
					configuration={configuration}
					context="active"
					onClose={() => setActiveOpen(false)}
					onSubmit={(request) => setNotice(`ACTIVE ${JSON.stringify(request)}`)}
				/>
			</Show>
		</box>
	)
}

await render(() => <Fixture />, renderer)
renderer.start()
await destroyed
