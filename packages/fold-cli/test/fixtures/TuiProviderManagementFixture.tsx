import type { ModelConfiguration } from '@humanlayer/fold-agent'
/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { createSignal, Show } from 'solid-js'

import { ProviderConfigPage } from '../../src/tui/ProviderConfigPage'
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
const oldProviders: ModelConfiguration['providers'] = [
	{
		name: 'openai',
		kind: 'openai-compat' as const,
		baseUrl: 'https://api.openai.com/v1',
		apiKeyEnv: 'OPENAI_API_KEY',
		credentialPresent: false,
		models: [],
	},
	{
		name: 'anthropic',
		kind: 'anthropic' as const,
		baseUrl: 'https://api.anthropic.com',
		apiKeyEnv: 'ANTHROPIC_API_KEY',
		credentialPresent: false,
		models: [],
	},
	{
		name: 'codex',
		kind: 'codex' as const,
		baseUrl: 'https://chatgpt.com/backend-api/codex',
		apiKeyEnv: null,
		credentialPresent: null,
		models: ['gpt-5.6-sol'],
	},
]
const [configuration, setConfiguration] = createSignal<ModelConfiguration>({ profiles: [], providers: oldProviders })
const [providersOpen, setProvidersOpen] = createSignal(false)

await render(
	() => (
		<Show
			when={providersOpen()}
			fallback={
				<SessionPicker
					cwd={process.cwd()}
					mode="default"
					profile="default"
					configuration={configuration()}
					sessions={sessions}
					notice={notice}
					opening={() => false}
					onOpen={() => {}}
					onDelete={() => {}}
					onNew={() => {}}
					onOpenProviders={() => setProvidersOpen(true)}
					onQuit={() => renderer.destroy()}
				/>
			}
		>
			<ProviderConfigPage
				configuration={configuration()}
				configExists
				onClose={() => setProvidersOpen(false)}
				onAuth={(target, action, update) =>
					update({
						_tag: 'success',
						message: `AUTH UPDATED: ${target.name} ${action}`,
						authStatus: action === 'logout' ? 'logged-out' : 'logged-in',
					})
				}
				onInitialize={() => {}}
				onCopyUrl={() => true}
				onConfigure={(input, update) => {
					setConfiguration((current) => ({
						...current,
						providers: [
							...current.providers,
							{
								name: input.name,
								kind: input.kind,
								baseUrl: input.baseUrl,
								apiKeyEnv: null,
								credentialPresent: null,
								models: input.model === undefined ? [] : [input.model],
							},
						],
					}))
					update({ _tag: 'success', message: `SAVED: ${input.name}` })
				}}
			/>
		</Show>
	),
	renderer,
)
renderer.start()
await destroyed
