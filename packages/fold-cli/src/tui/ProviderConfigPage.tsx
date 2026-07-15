/** @jsxImportSource @opentui/solid */
import type { ConfigureProviderInput, ModelConfiguration } from '@humanlayer/fold-agent'
import { TextAttributes, type KeyEvent, type TextareaRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createMemo, createSignal, For, onMount, Show } from 'solid-js'

import {
	providerAuthActions,
	providerCredentialLabel,
	type ProviderAuthAction,
	type ProviderAuthTarget,
	type ProviderAuthUpdate,
} from './ProviderAuth'
import {
	providerManagementRows,
	providerFormFor,
	providerInput,
	type ProviderForm,
	type ProviderManagementRow,
} from './ProviderConfigState'
import { theme } from './ThemeState'

export const ProviderConfigPage = (props: {
	readonly configuration: ModelConfiguration
	readonly configExists: boolean
	readonly onClose: () => void
	readonly onAuth: (
		target: ProviderAuthTarget,
		action: ProviderAuthAction,
		update: (state: ProviderAuthUpdate) => void,
	) => void
	readonly onInitialize: (update: (state: ProviderAuthUpdate) => void) => void
	readonly onConfigure: (input: ConfigureProviderInput, update: (state: ProviderAuthUpdate) => void) => void
	readonly onCopyUrl: (url: string) => boolean
}) => {
	const [selected, setSelected] = createSignal(0)
	const [state, setState] = createSignal<ProviderAuthUpdate | null>(null)
	const [authStates, setAuthStates] = createSignal<Readonly<Record<string, ProviderAuthUpdate>>>({})
	const [form, setForm] = createSignal<ProviderForm | null>(null)
	const [field, setField] = createSignal(0)
	const [copyNotice, setCopyNotice] = createSignal<string | null>(null)
	const editors: Array<TextareaRenderable | undefined> = []
	const rows = createMemo(() => providerManagementRows(props.configuration))
	const currentRow = () => rows()[selected()]
	const current = () => {
		const row = currentRow()
		return row?.type === 'configured' ? row.provider : undefined
	}
	const formFields = createMemo<ReadonlyArray<'name' | 'baseUrl' | 'apiKey' | 'model'>>(() =>
		['codex', 'opencode', 'xai'].includes(form()?.kind ?? '')
			? ['name', 'baseUrl', 'model']
			: ['name', 'baseUrl', 'apiKey', 'model'],
	)
	const oauthKindFor = (row: ProviderManagementRow | undefined) => {
		const kind = row?.type === 'configured' ? row.provider.kind : row?.form.kind
		return kind === 'codex' || kind === 'opencode' || kind === 'xai' ? kind : null
	}
	const currentOAuthKind = () => oauthKindFor(currentRow())
	const authTargetFor = (row: ProviderManagementRow | undefined): ProviderAuthTarget | null => {
		const kind = oauthKindFor(row)
		if (kind === null || row === undefined) return null
		if (row.type === 'configured') return { name: row.provider.name, kind }
		return { name: row.form.name, kind, configuration: providerInput(row.form) }
	}
	const updateAuthState = (target: ProviderAuthTarget, update: ProviderAuthUpdate, announce: boolean) => {
		setAuthStates((current) => ({ ...current, [target.name]: update }))
		if (announce) {
			setCopyNotice(null)
			setState(update)
		}
	}
	const runFor = (target: ProviderAuthTarget, action: ProviderAuthAction, announce: boolean) => {
		if (providerAuthActions(target.kind).includes(action))
			props.onAuth(target, action, (update) => updateAuthState(target, update, announce))
	}
	const run = (action: ProviderAuthAction) => {
		const target = authTargetFor(currentRow())
		if (target !== null) runFor(target, action, true)
	}
	onMount(() => {
		for (const row of rows()) {
			const target = authTargetFor(row)
			if (target !== null) runFor(target, 'status', false)
		}
	})
	const authMethods = (kind: 'codex' | 'opencode' | 'xai'): string =>
		providerAuthActions(kind).includes('browser') ? 'B browser · D device' : 'D device'
	const authOptions = (row: ProviderManagementRow): string => {
		const kind = oauthKindFor(row)
		return kind === null ? 'Enter API key' : authMethods(kind)
	}
	const providerType = (row: ProviderManagementRow): string => {
		const kind = row.type === 'configured' ? row.provider.kind : row.form.kind
		if (kind === 'openai-compat') return row.section === 'api' ? 'OpenAI API' : 'OpenAI-compatible'
		if (kind === 'anthropic') return row.section === 'api' ? 'Anthropic API' : 'Anthropic-compatible'
		return 'OAuth'
	}
	const authStatus = (row: ProviderManagementRow): string => {
		const target = authTargetFor(row)
		if (target !== null) {
			const update = authStates()[target.name]
			if (update === undefined || update._tag === 'working') return 'CHECKING...'
			if (update._tag === 'browser' || update._tag === 'device') return 'LOGIN PENDING'
			if (update._tag === 'failure') return 'ERROR'
			if (update.authStatus === 'logged-in') return 'LOGGED IN'
			if (update.authStatus === 'logged-out') return 'LOGGED OUT'
			if (update.authStatus === 'expired') return 'EXPIRED'
			return 'STATUS UNKNOWN'
		}
		if (row.type === 'create') return 'NOT CONFIGURED'
		return `${providerCredentialLabel(row.provider.credentialPresent)}${row.provider.apiKeyEnv === null ? '' : ` · ${row.provider.apiKeyEnv}`}`
	}
	const sectionLabel = (section: ProviderManagementRow['section']): string =>
		section === 'api' ? 'BUILT-IN API PROVIDERS' : section === 'oauth' ? 'OAUTH PROVIDERS' : 'COMPATIBLE PROVIDERS'
	const startForm = (value: ProviderForm) => {
		setState(null)
		setForm(value)
		setField(0)
	}
	const configure = (value: ProviderForm) => {
		const name = value.name.trim()
		props.onConfigure(providerInput(value), (update) => {
			setState(update)
			if (update._tag === 'success') {
				setForm(null)
				queueMicrotask(() => {
					const index = rows().findIndex((row) => row.type === 'configured' && row.provider.name === name)
					if (index >= 0) setSelected(index)
				})
			}
		})
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
			else if (key.name === 'enter' || key.name === 'return') {
				if (field() < formFields().length) moveField(1)
				else {
					const value = form()
					if (value !== null) configure(value)
				}
			} else return
			key.preventDefault()
			return
		}
		if (key.name === 'escape') props.onClose()
		else if (key.name === 'up' || key.name === 'k') setSelected((value) => Math.max(0, value - 1))
		else if (key.name === 'down' || key.name === 'j') setSelected((value) => Math.min(rows().length - 1, value + 1))
		else if (key.name === 's') run('status')
		else if (key.name === 'b') run('browser')
		else if (key.name === 'd') run('device')
		else if (key.name === 'l') run('logout')
		else if (key.name === 'c') {
			const value = state()
			if (value?._tag === 'browser' || value?._tag === 'device')
				setCopyNotice(props.onCopyUrl(value.url) ? 'URL COPIED' : 'CLIPBOARD UNAVAILABLE')
		} else if (key.name === 'i' && !props.configExists) props.onInitialize(setState)
		else if (key.name === 'enter' || key.name === 'return') {
			const row = currentRow()
			if (oauthKindFor(row) !== null) return
			if (row?.type === 'configured') startForm(providerFormFor(props.configuration, row.provider.name))
			else if (row?.type === 'create') startForm(row.form)
		}
	})
	const stateText = createMemo(() => {
		const value = state()
		if (value === null) return ''
		if (value._tag === 'browser')
			return `${value.opened ? 'Browser opened' : 'Open this URL'}: ${value.url}\nWaiting for browser callback...`
		if (value._tag === 'device')
			return `${value.opened ? 'Browser opened' : 'Open'}: ${value.url}\nCode: ${value.code}\nWaiting for approval...`
		return value.message
	})
	return (
		<box
			width="100%"
			height="100%"
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
					<box flexDirection="column">
						<Show when={!props.configExists}>
							<text fg={theme.color.alert}>
								No config.jsonc exists. Press I to initialize a starter config (existing files are not
								replaced), or configure a row to initialize automatically.
							</text>
						</Show>
						<box height={1} />
						<text fg={theme.color.textDim} wrapMode="none">
							OAuth credentials are stored separately and never shown · API-key rows show presence only
						</text>
						<box flexDirection="row">
							<text width={31} fg={theme.color.textFaint} wrapMode="none">
								PROVIDER
							</text>
							<text width={22} fg={theme.color.textFaint} wrapMode="none">
								TYPE
							</text>
							<text width={24} fg={theme.color.textFaint} wrapMode="none">
								AUTH OPTIONS
							</text>
							<text flexGrow={1} fg={theme.color.textFaint} wrapMode="none" truncate>
								AUTH STATUS
							</text>
						</box>
						<For
							each={rows()}
							fallback={<text fg={theme.color.alert}>No providers configured in config.jsonc.</text>}
						>
							{(row, index) => (
								<>
									<Show when={index() === 0 || rows()[index() - 1]?.section !== row.section}>
										<text fg={theme.color.core} wrapMode="none">
											{sectionLabel(row.section)}
										</text>
									</Show>
									<box
										flexDirection="row"
										backgroundColor={
											selected() === index() ? theme.color.panel : theme.color.raised
										}
									>
										<text
											width={31}
											fg={selected() === index() ? theme.color.coreBright : theme.color.text}
											wrapMode="none"
											truncate
										>{`${selected() === index() ? '▸ ' : '  '}${row.label}`}</text>
										<text width={22} fg={theme.color.textDim} wrapMode="none" truncate>
											{providerType(row)}
										</text>
										<text width={24} fg={theme.color.text} wrapMode="none" truncate>
											{authOptions(row)}
										</text>
										<text
											flexGrow={1}
											wrapMode="none"
											truncate
											fg={
												row.type === 'configured' && row.provider.credentialPresent === false
													? theme.color.alert
													: theme.color.textDim
											}
										>
											{authStatus(row)}
										</text>
									</box>
								</>
							)}
						</For>
					</box>
				}
			>
				<Show when={!['codex', 'opencode', 'xai'].includes(form()?.kind ?? '')}>
					<text fg={theme.color.alert}>WARNING: API key is stored inline in mode-0600 config.jsonc.</text>
				</Show>
				<text fg={theme.color.textDim}>Kind: {form()?.kind}</text>
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
			<Show when={form() === null && currentRow() !== undefined && currentOAuthKind() === null}>
				<text fg={theme.color.textDim}>
					Press Enter to {current() === undefined ? 'configure this provider' : 'update base URL/model'}
					{current() !== undefined && ' (the API key must be entered again)'}.
				</text>
			</Show>
			<Show when={state() !== null}>
				<text fg={state()?._tag === 'failure' ? theme.color.alert : theme.color.text}>{stateText()}</text>
			</Show>
			<Show when={copyNotice() !== null}>
				<text fg={theme.color.coreBright}>{copyNotice()}</text>
			</Show>
			<box flexGrow={1} />
			<text fg={theme.color.textDim}>
				{form() !== null
					? 'Tab/↑↓ fields · Enter next/save · ⎋ cancel'
					: currentOAuthKind() === 'opencode'
						? '↑↓ select · OpenCode OAuth: S status · D device · C copy URL · L logout · ⎋ close'
						: currentOAuthKind() !== null
							? '↑↓ select · OAuth: S status · B browser · D device · C copy URL · L logout · ⎋ close'
							: props.configExists
								? '↑↓ select · Enter configure/update · ⎋ close'
								: '↑↓ select · Enter configure + initialize · I initialize config · ⎋ close'}
			</text>
		</box>
	)
}
