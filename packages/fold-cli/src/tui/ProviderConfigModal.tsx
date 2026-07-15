/** @jsxImportSource @opentui/solid */
import type { ConfigureProviderInput, ModelConfiguration } from '@humanlayer/fold-agent'
import { TextAttributes, type KeyEvent, type TextareaRenderable } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/solid'
import { createMemo, createSignal, For, Show } from 'solid-js'

import {
	oauthProviderLabel,
	providerAuthActions,
	providerCredentialLabel,
	type ProviderAuthAction,
	type ProviderAuthUpdate,
} from './ProviderAuth'
import {
	emptyProviderForm,
	providerFormFor,
	providerInput,
	withNextProviderKind,
	type ProviderForm,
} from './ProviderConfigState'
import { theme } from './ThemeState'

export const ProviderConfigModal = (props: {
	readonly configuration: ModelConfiguration
	readonly configExists: boolean
	readonly onClose: () => void
	readonly onAuth: (provider: string, action: ProviderAuthAction, update: (state: ProviderAuthUpdate) => void) => void
	readonly onInitialize: (update: (state: ProviderAuthUpdate) => void) => void
	readonly onConfigure: (input: ConfigureProviderInput, update: (state: ProviderAuthUpdate) => void) => void
}) => {
	const dimensions = useTerminalDimensions()
	const [selected, setSelected] = createSignal(0)
	const [state, setState] = createSignal<ProviderAuthUpdate | null>(null)
	const [form, setForm] = createSignal<ProviderForm | null>(null)
	const [field, setField] = createSignal(0)
	const editors: Array<TextareaRenderable | undefined> = []
	const providers = () => props.configuration.providers
	const current = () => providers()[selected()]
	const formFields = createMemo<ReadonlyArray<'name' | 'baseUrl' | 'apiKey' | 'model'>>(() =>
		['codex', 'opencode', 'xai'].includes(form()?.kind ?? '')
			? ['name', 'baseUrl', 'model']
			: ['name', 'baseUrl', 'apiKey', 'model'],
	)
	const currentOAuthKind = () => {
		const kind = current()?.kind
		return kind === 'codex' || kind === 'opencode' || kind === 'xai' ? kind : null
	}
	const credentialDescription = (provider: ModelConfiguration['providers'][number]): string => {
		if (provider.kind === 'codex' || provider.kind === 'opencode' || provider.kind === 'xai')
			return `${oauthProviderLabel(provider.kind)} · ${providerCredentialLabel(null)}`
		return `API KEY · ${provider.apiKeyEnv ?? 'inline'} · ${providerCredentialLabel(provider.credentialPresent)}`
	}
	const run = (action: ProviderAuthAction) => {
		const provider = current()
		const kind = currentOAuthKind()
		if (provider !== undefined && kind !== null && providerAuthActions(kind).includes(action))
			props.onAuth(provider.name, action, setState)
	}
	const startForm = (value: ProviderForm) => {
		setState(null)
		setForm(value)
		setField(0)
	}
	const setValue = (key: 'name' | 'baseUrl' | 'apiKey' | 'model', value: string) =>
		setForm((current) => (current === null ? current : { ...current, [key]: value }))
	const moveField = (offset: number) => {
		setField((current) => Math.max(0, Math.min(formFields().length, current + offset)))
		queueMicrotask(() => editors[field()]?.focus())
	}
	useKeyboard((key: KeyEvent) => {
		if (key.eventType === 'release') return
		if (form() !== null) {
			if (key.name === 'escape') setForm(null)
			else if (key.name === 'tab' || key.name === 'down') moveField(1)
			else if (key.name === 'up') moveField(-1)
			else if (field() === 0 && (key.name === 'left' || key.name === 'right' || key.name === 'space'))
				setForm((current) => (current === null ? null : withNextProviderKind(current)))
			else if (key.name === 'enter' || key.name === 'return') {
				if (field() < formFields().length) moveField(1)
				else {
					const value = form()
					if (value !== null) props.onConfigure(providerInput(value), setState)
				}
			} else return
			key.preventDefault()
			return
		}
		if (key.name === 'escape') props.onClose()
		else if (key.name === 'up' || key.name === 'k') setSelected((value) => Math.max(0, value - 1))
		else if (key.name === 'down' || key.name === 'j')
			setSelected((value) => Math.min(providers().length - 1, value + 1))
		else if (key.name === 's') run('status')
		else if (key.name === 'b') run('browser')
		else if (key.name === 'd') run('device')
		else if (key.name === 'l') run('logout')
		else if (key.name === 'i' && !props.configExists) props.onInitialize(setState)
		else if (key.name === 'a' && props.configExists) startForm(emptyProviderForm())
		else if (key.name === 'enter' || key.name === 'return') {
			const provider = current()
			if (provider !== undefined) startForm(providerFormFor(props.configuration, provider.name))
		}
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
			height={Math.min(28, dimensions().height - 6)}
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
				when={form() !== null}
				fallback={
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
						<text fg={theme.color.textDim}>
							OAuth credentials are stored separately and never shown · API-key rows show presence only
						</text>
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
										fg={
											provider.credentialPresent === false
												? theme.color.alert
												: theme.color.textDim
										}
									>
										{credentialDescription(provider)}
									</text>
								</box>
							)}
						</For>
					</Show>
				}
			>
				<Show when={!['codex', 'opencode', 'xai'].includes(form()?.kind ?? '')}>
					<text fg={theme.color.alert}>WARNING: API key is stored inline in mode-0600 config.jsonc.</text>
				</Show>
				<text fg={theme.color.textDim}>Kind (←/→/Space): {form()?.kind}</text>
				<For each={formFields()}>
					{(name, index) => (
						<box flexDirection="column">
							<text fg={field() === index() + 1 ? theme.color.coreBright : theme.color.textDim}>
								{
									{
										name: 'Provider name',
										baseUrl: 'Base URL',
										apiKey: 'API key',
										model: 'Model ID (optional)',
									}[name]
								}
							</text>
							<textarea
								ref={(value: TextareaRenderable) => (editors[index() + 1] = value)}
								focused={field() === index() + 1}
								initialValue={form()?.[name] ?? ''}
								onContentChange={() => setValue(name, editors[index() + 1]?.plainText ?? '')}
								height={1}
								backgroundColor={theme.color.panel}
								focusedBackgroundColor={theme.color.panel}
								textColor={theme.color.text}
								focusedTextColor={theme.color.coreBright}
								cursorColor={theme.color.coreBright}
							/>
						</box>
					)}
				</For>
			</Show>
			<box height={1} />
			<Show when={form() === null && current() !== undefined}>
				<text fg={theme.color.textDim}>
					Press Enter to update base URL/model
					{currentOAuthKind() === null
						? ' (the API key must be entered again)'
						: ' without exposing its OAuth token'}
					.
				</text>
			</Show>
			<Show when={state() !== null}>
				<text fg={state()?._tag === 'failure' ? theme.color.alert : theme.color.text}>{stateText()}</text>
			</Show>
			<box flexGrow={1} />
			<text fg={theme.color.textDim}>
				{form() !== null
					? 'Tab/↑↓ fields · Enter next/save · ⎋ cancel'
					: props.configExists
						? currentOAuthKind() === 'opencode'
							? '↑↓ select · A add · Enter update · OpenCode: S status · D device · L logout · ⎋ close'
							: '↑↓ select · A add · Enter update · OAuth: S status · B browser · D device · L logout · ⎋ close'
						: 'I initialize config · ⎋ close'}
			</text>
		</box>
	)
}
