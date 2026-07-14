/** @jsxImportSource @opentui/solid */
import type { ModelConfiguration } from '@humanlayer/tart-agent'
import { TextAttributes, type KeyEvent } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/solid'
import { createMemo, createSignal, For, Show } from 'solid-js'

import { providerCredentialLabel, type ProviderAuthAction, type ProviderAuthUpdate } from './ProviderAuth'
import { theme } from './ThemeState'

export const ProviderConfigModal = (props: {
	readonly configuration: ModelConfiguration
	readonly configExists: boolean
	readonly onClose: () => void
	readonly onAuth: (provider: string, action: ProviderAuthAction, update: (state: ProviderAuthUpdate) => void) => void
	readonly onInitialize: (update: (state: ProviderAuthUpdate) => void) => void
}) => {
	const dimensions = useTerminalDimensions()
	const [selected, setSelected] = createSignal(0)
	const [state, setState] = createSignal<ProviderAuthUpdate | null>(null)
	const providers = () => props.configuration.providers
	const current = () => providers()[selected()]
	const run = (action: ProviderAuthAction) => {
		const provider = current()
		if (provider?.kind === 'codex') props.onAuth(provider.name, action, setState)
	}
	useKeyboard((key: KeyEvent) => {
		if (key.eventType === 'release') return
		if (key.name === 'escape') props.onClose()
		else if (key.name === 'up' || key.name === 'k') setSelected((value) => Math.max(0, value - 1))
		else if (key.name === 'down' || key.name === 'j')
			setSelected((value) => Math.min(providers().length - 1, value + 1))
		else if (key.name === 's') run('status')
		else if (key.name === 'b') run('browser')
		else if (key.name === 'd') run('device')
		else if (key.name === 'l') run('logout')
		else if (key.name === 'i' && !props.configExists) props.onInitialize(setState)
	})
	const width = createMemo(() => Math.min(92, dimensions().width - 4))
	const stateText = createMemo(() => {
		const value = state()
		if (value === null) return ''
		if (value._tag === 'browser')
			return `${value.opened ? 'Browser opened' : 'Open this URL'}: ${value.url}\nWaiting for browser callback...`
		if (value._tag === 'device') return `Open: ${value.url}\nCode: ${value.code}\nWaiting for approval...`
		return value.message
	})
	return (
		<box
			position="absolute"
			top={3}
			left={Math.max(2, Math.floor((dimensions().width - width()) / 2))}
			width={width()}
			height={Math.min(24, dimensions().height - 6)}
			zIndex={60}
			flexDirection="column"
			border
			borderStyle="double"
			borderColor={theme.color.coreBright}
			backgroundColor={theme.color.raised}
			padding={1}
		>
			<text height={1} flexShrink={0} fg={theme.color.coreBright} attributes={TextAttributes.BOLD}>
				PROVIDERS / AUTH
			</text>
			<Show
				when={props.configExists}
				fallback={
					<text fg={theme.color.alert}>
						No config.jsonc exists. Press I to initialize a starter config (existing files are not
						replaced).
					</text>
				}
			>
				<box height={1} />
				<For
					each={providers()}
					fallback={<text fg={theme.color.alert}>No providers configured in config.jsonc.</text>}
				>
					{(provider, index) => (
						<box
							flexDirection="row"
							backgroundColor={selected() === index() ? theme.color.panel : theme.color.raised}
						>
							<text
								width={22}
								fg={selected() === index() ? theme.color.coreBright : theme.color.text}
							>{`${selected() === index() ? '▸ ' : '  '}${provider.name}`}</text>
							<text width={12} fg={theme.color.textDim}>
								{provider.kind}
							</text>
							<text width={12} fg={theme.color.text}>{`${provider.models.length} models`}</text>
							<text
								flexGrow={1}
								fg={provider.credentialPresent === false ? theme.color.alert : theme.color.textDim}
							>
								{provider.kind === 'codex'
									? providerCredentialLabel(null)
									: `${provider.apiKeyEnv ?? 'apiKeyEnv not set'} · ${providerCredentialLabel(provider.credentialPresent)}`}
							</text>
						</box>
					)}
				</For>
			</Show>
			<box height={1} />
			<Show when={current()?.kind !== 'codex' && current() !== undefined}>
				<text fg={theme.color.textDim}>
					Set {current()?.apiKeyEnv ?? 'apiKeyEnv in config.jsonc, then that environment variable'} before
					starting Tart. Secrets are never entered or stored here.
				</text>
			</Show>
			<Show when={state() !== null}>
				<text fg={state()?._tag === 'failure' ? theme.color.alert : theme.color.text}>{stateText()}</text>
			</Show>
			<box flexGrow={1} />
			<text fg={theme.color.textDim}>
				{props.configExists
					? '↑↓ select · Codex: S status · B browser login · D device login · L logout · ⎋ close'
					: 'I initialize config · ⎋ close'}
			</text>
		</box>
	)
}
