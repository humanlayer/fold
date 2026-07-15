/** @jsxImportSource @opentui/solid */
import {
	configureProvider,
	configInit,
	defaultFoldHome,
	describeModelConfiguration,
	ensureManagedBinaries,
	loadViewedPatchHashes,
	loadFoldConfigOrNull,
	saveViewedPatchHash,
	type ModelConfiguration,
	type FoldConfig,
	type ViewedPatchHashes,
} from '@humanlayer/fold-agent'
import { makeCodexAuth, makeCodexAuthStore } from '@humanlayer/fold-codex'
import type { SessionId } from '@humanlayer/fold-core'
import { makeOpenCodeAuth, makeOpenCodeAuthStore } from '@humanlayer/fold-opencode'
import { ALL_FX_ON, type FxToggles } from '@humanlayer/fold-tui-theme/postfx'
import { nextThemeId, type ThemeId } from '@humanlayer/fold-tui-theme/themes'
import { makeXaiAuth, makeXaiAuthStore } from '@humanlayer/fold-xai'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { Cause, Clock, Deferred, Effect, Option, Schema, Scope } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { batch, createEffect, createSignal, Show, type Accessor } from 'solid-js'

import { TuiApp } from './App'
import { loadGitSnapshot, type GitSnapshot } from './GitChanges'
import type { HostedTuiSession } from './HostedTuiSession'
import { openUrlInBrowser } from './OpenUrl'
import {
	codexAuthStoreOptions,
	openCodeAuthStoreOptions,
	xaiAuthStoreOptions,
	type ProviderAuthAction,
	type ProviderAuthTarget,
	type ProviderAuthUpdate,
} from './ProviderAuth'
import { ProviderConfigPage } from './ProviderConfigPage'
import { SessionPicker } from './SessionPicker'
import { setCurrentTheme } from './ThemeState'
import { bootstrapTuiConfig } from './TuiConfigBootstrap'
import { makeTuiRouter } from './TuiRouter'
import type { TuiOptions } from './TuiSessionOptions'
import { makeTuiSessionWorkspace, type TuiInitialSessionError } from './TuiSessionWorkspace'
import { markChangeViewed } from './ViewedChanges'

export class TuiRequiresTtyError extends Schema.TaggedErrorClass<TuiRequiresTtyError>()('TuiRequiresTtyError', {}) {}
export class TuiRendererError extends Schema.TaggedErrorClass<TuiRendererError>()('TuiRendererError', {
	message: Schema.String,
}) {}
export type { TuiOptions } from './TuiSessionOptions'

export const runTui = (
	options: TuiOptions,
): Effect.Effect<void, TuiRequiresTtyError | TuiRendererError | TuiInitialSessionError, Scope.Scope> =>
	Effect.gen(function* () {
		if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return yield* new TuiRequiresTtyError()
		const quit = yield* Deferred.make<void>()
		const runFork = Effect.runForkWith(yield* Effect.context<Scope.Scope>())
		const configOptions = options.foldHome === undefined ? {} : { foldHome: options.foldHome }
		// Bootstrap before config loading. A failed bootstrap is visible in the TUI and must not be
		// mistaken for a successful load with no config.
		const bootstrapped = yield* bootstrapTuiConfig(configOptions)
		// Downloads should not delay the first frame, but remain scoped to the TUI lifetime.
		yield* Effect.forkScoped(
			ensureManagedBinaries({
				foldHome: options.foldHome ?? defaultFoldHome(),
				requireManagedInstall: true,
				suppressWarnings: true,
			}).pipe(Effect.asVoid),
		)
		const initialConfig = bootstrapped.config
		const initialConfiguration: ModelConfiguration =
			initialConfig === null
				? { profiles: [], providers: [] }
				: describeModelConfiguration(initialConfig, options.catalog ?? [])
		const configNotice = bootstrapped.notice
		const renderer = yield* Effect.tryPromise({
			try: () =>
				createCliRenderer({
					targetFps: 30,
					exitOnCtrlC: false,
					consoleMode: 'disabled',
					useKittyKeyboard: {},
					onDestroy: () => Deferred.doneUnsafe(quit, Effect.void),
				}),
			catch: (error) => new TuiRendererError({ message: String(error) }),
		})
		yield* Effect.addFinalizer(() => Effect.sync(() => renderer.destroy()))
		const [themeId, setThemeId] = createSignal<ThemeId>('tactical')
		const [config, setConfig] = createSignal<FoldConfig | null>(initialConfig)
		const [configuration, setConfiguration] = createSignal<ModelConfiguration>(initialConfiguration)
		const [focusInputOnActivation, setFocusInputOnActivation] = createSignal(false)
		const [toggles, setToggles] = createSignal<FxToggles>({
			...ALL_FX_ON,
			glow: false,
			vignette: 'light',
		})
		const [gitSnapshot, setGitSnapshot] = createSignal<GitSnapshot>({ _tag: 'ready', files: [] })
		const [viewedChanges, setViewedChanges] = createSignal<Readonly<Record<string, ViewedPatchHashes>>>({})
		const loadedViewedChanges = new Set<SessionId>()
		let gitRefreshGeneration = 0
		const selectTheme = (id: ThemeId): void => {
			setCurrentTheme(id)
			setThemeId(id)
		}
		const cycleTheme = (): void => selectTheme(nextThemeId(themeId()))
		const refreshGit = (cwd: string): void => {
			const generation = ++gitRefreshGeneration
			setGitSnapshot({ _tag: 'loading', message: 'REFRESHING GIT SNAPSHOT' })
			runFork(
				loadGitSnapshot(cwd).pipe(
					Effect.tap((snapshot) =>
						Effect.sync(() => {
							if (generation === gitRefreshGeneration) setGitSnapshot(snapshot)
						}),
					),
				),
			)
		}
		const updateAuth = (
			target: ProviderAuthTarget,
			action: ProviderAuthAction,
			update: (state: ProviderAuthUpdate) => void,
		): void => {
			const provider = target.name
			const providerKind = target.kind
			runFork(
				Effect.gen(function* () {
					const configured = configuration().providers.some(
						(candidate) => candidate.name === provider && candidate.kind === providerKind,
					)
					if (
						!configured &&
						target.configuration !== undefined &&
						(action === 'browser' || action === 'device')
					) {
						update({
							_tag: 'working',
							message: `Adding ${provider} with its standard OAuth configuration...`,
						})
						const updated = yield* config() === null
							? configInit(configOptions).pipe(
									Effect.andThen(configureProvider(target.configuration, configOptions)),
								)
							: configureProvider(target.configuration, configOptions)
						setConfig(updated)
						setConfiguration(describeModelConfiguration(updated, options.catalog ?? []))
					}
					if (providerKind === 'opencode') {
						const store = makeOpenCodeAuthStore(openCodeAuthStoreOptions(provider, options.foldHome))
						if (action === 'status') {
							update({ _tag: 'working', message: 'Checking stored OpenCode credential...' })
							const token = yield* store.load
							if (Option.isNone(token))
								return update({
									_tag: 'success',
									message: 'No OpenCode credential stored.',
									authStatus: 'logged-out',
								})
							const now = yield* Clock.currentTimeMillis
							const expired = token.value.isExpired(now)
							return update({
								_tag: 'success',
								message: `OpenCode credential is ${expired ? 'expired' : 'valid'} (expires ${new Date(token.value.expires).toISOString()}).`,
								authStatus: expired ? 'expired' : 'logged-in',
							})
						}
						const auth = yield* makeOpenCodeAuth({
							store,
							onDeviceCode: (prompt) =>
								openUrlInBrowser(prompt.url).pipe(
									Effect.tap((opened) =>
										Effect.sync(() =>
											update({ _tag: 'device', url: prompt.url, code: prompt.userCode, opened }),
										),
									),
									Effect.asVoid,
								),
						}).pipe(Effect.provide(FetchHttpClient.layer))
						if (action === 'logout') {
							yield* auth.logout
							return update({
								_tag: 'success',
								message: 'OpenCode credential removed.',
								authStatus: 'logged-out',
							})
						}
						if (action === 'browser')
							return update({ _tag: 'failure', message: 'OpenCode supports device login only. Press D.' })
						update({ _tag: 'working', message: 'Starting OpenCode device login...' })
						yield* auth.authenticateDevice
						return update({
							_tag: 'success',
							message: 'OpenCode authentication saved successfully.',
							authStatus: 'logged-in',
						})
					}
					if (providerKind === 'xai') {
						const store = makeXaiAuthStore(xaiAuthStoreOptions(provider, options.foldHome))
						if (action === 'status') {
							update({ _tag: 'working', message: 'Checking stored xAI credential...' })
							const token = yield* store.load
							if (Option.isNone(token))
								return update({
									_tag: 'success',
									message: 'No xAI credential stored.',
									authStatus: 'logged-out',
								})
							const now = yield* Clock.currentTimeMillis
							const expired = token.value.isExpired(now)
							return update({
								_tag: 'success',
								message: `xAI credential is ${expired ? 'expired' : 'valid'} (expires ${new Date(token.value.expires).toISOString()}).`,
								authStatus: expired ? 'expired' : 'logged-in',
							})
						}
						const auth = yield* makeXaiAuth({
							store,
							onBrowserUrl: (url) =>
								openUrlInBrowser(url).pipe(
									Effect.tap((opened) => Effect.sync(() => update({ _tag: 'browser', url, opened }))),
									Effect.asVoid,
								),
							onDeviceCode: (prompt) =>
								openUrlInBrowser(prompt.browserUrl).pipe(
									Effect.tap((opened) =>
										Effect.sync(() =>
											update({
												_tag: 'device',
												url: prompt.browserUrl,
												code: prompt.userCode,
												opened,
											}),
										),
									),
									Effect.asVoid,
								),
						}).pipe(Effect.provide(FetchHttpClient.layer))
						if (action === 'logout') {
							yield* auth.logout
							return update({
								_tag: 'success',
								message: 'xAI credential removed.',
								authStatus: 'logged-out',
							})
						}
						update({ _tag: 'working', message: `Starting xAI ${action} login...` })
						yield* action === 'browser' ? auth.authenticateBrowser : auth.authenticateDevice
						return update({
							_tag: 'success',
							message: 'xAI authentication saved successfully.',
							authStatus: 'logged-in',
						})
					}
					const store = makeCodexAuthStore(codexAuthStoreOptions(provider, options.foldHome))
					if (action === 'status') {
						update({ _tag: 'working', message: 'Checking stored credential...' })
						const token = yield* store.load
						if (Option.isNone(token))
							return update({
								_tag: 'success',
								message: 'No Codex credential stored.',
								authStatus: 'logged-out',
							})
						const now = yield* Clock.currentTimeMillis
						const expired = token.value.isExpired(now)
						return update({
							_tag: 'success',
							message: `Codex credential is ${expired ? 'expired' : 'valid'} (expires ${new Date(token.value.expires).toISOString()}).`,
							authStatus: expired ? 'expired' : 'logged-in',
						})
					}
					const auth = yield* makeCodexAuth({
						store,
						onBrowserUrl: (url) =>
							openUrlInBrowser(url).pipe(
								Effect.tap((opened) => Effect.sync(() => update({ _tag: 'browser', url, opened }))),
								Effect.asVoid,
							),
						onDeviceCode: (prompt) =>
							openUrlInBrowser(prompt.verifyUrl).pipe(
								Effect.tap((opened) =>
									Effect.sync(() =>
										update({
											_tag: 'device',
											url: prompt.verifyUrl,
											code: prompt.userCode,
											opened,
										}),
									),
								),
								Effect.asVoid,
							),
					}).pipe(Effect.provide(FetchHttpClient.layer))
					if (action === 'logout') {
						update({ _tag: 'working', message: 'Removing stored credential...' })
						yield* auth.logout
						return update({
							_tag: 'success',
							message: 'Codex credential removed.',
							authStatus: 'logged-out',
						})
					}
					update({ _tag: 'working', message: `Starting ${action} login...` })
					yield* action === 'browser' ? auth.authenticateBrowser : auth.authenticateDevice
					update({
						_tag: 'success',
						message: 'Codex authentication saved successfully.',
						authStatus: 'logged-in',
					})
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() => update({ _tag: 'failure', message: Cause.pretty(cause) })),
					),
				),
			)
		}
		const initializeConfig = (update: (state: ProviderAuthUpdate) => void): void => {
			update({ _tag: 'working', message: 'Initializing Fold configuration...' })
			runFork(
				configInit(options.foldHome === undefined ? {} : { foldHome: options.foldHome }).pipe(
					Effect.andThen(
						loadFoldConfigOrNull(options.foldHome === undefined ? {} : { foldHome: options.foldHome }),
					),
					Effect.tap((loaded) =>
						Effect.sync(() => {
							if (loaded !== null) {
								setConfig(loaded)
								setConfiguration(describeModelConfiguration(loaded, options.catalog ?? []))
							}
							update({
								_tag: 'success',
								message: 'Configuration initialized and loaded.',
							})
						}),
					),
					Effect.catchCause((cause) =>
						Effect.sync(() => update({ _tag: 'failure', message: Cause.pretty(cause) })),
					),
				),
			)
		}
		const updateProvider = (
			input: Parameters<typeof configureProvider>[0],
			update: (state: ProviderAuthUpdate) => void,
		): void => {
			update({ _tag: 'working', message: 'Saving provider to mode-0600 config...' })
			runFork(
				(config() === null
					? configInit(configOptions).pipe(Effect.andThen(configureProvider(input, configOptions)))
					: configureProvider(input, configOptions)
				).pipe(
					Effect.tap((updated) =>
						Effect.sync(() => {
							setConfig(updated)
							setConfiguration(describeModelConfiguration(updated, options.catalog ?? []))
							update({
								_tag: 'success',
								message: `Provider ${input.name.trim()} saved and available now.`,
							})
						}),
					),
					Effect.catchCause((cause) =>
						Effect.sync(() => update({ _tag: 'failure', message: Cause.pretty(cause) })),
					),
				),
			)
		}

		const pickerFirst = options.resume === undefined && options.prompt === undefined
		const router = makeTuiRouter({ _tag: 'picker' })
		const workspace = yield* makeTuiSessionWorkspace({
			tui: options,
			configuration: configuration(),
			config,
			configNotice,
			loadSummariesOnStart: pickerFirst,
		})
		if (!pickerFirst) {
			const activation = router.beginSessionActivation()
			const hosted = yield* workspace.openInitial
			router.showSession(activation, hosted.sessionId)
		}
		const active = (): HostedTuiSession | null => {
			const route = router.route()
			return route._tag === 'session' ? workspace.get(route.sessionId) : null
		}
		const activate = (
			operation: Option.Option<Effect.Effect<HostedTuiSession, unknown>>,
			focusInput: boolean,
		): void => {
			if (Option.isNone(operation)) return
			const token = router.beginSessionActivation()
			runFork(
				operation.value.pipe(
					Effect.tap((hosted) =>
						Effect.sync(() =>
							batch(() => {
								if (router.showSession(token, hosted.sessionId)) setFocusInputOnActivation(focusInput)
							}),
						),
					),
					Effect.catchCause(() => Effect.void),
				),
			)
		}
		const remove = (sessionId: SessionId): void => {
			const operation = workspace.delete(sessionId)
			if (Option.isNone(operation)) return
			const route = router.route()
			const wasActive = route._tag === 'session' && route.sessionId === sessionId
			if (wasActive) router.showPicker()
			runFork(operation.value.pipe(Effect.catchCause(() => Effect.void)))
		}

		yield* Effect.tryPromise({
			try: () =>
				render(() => {
					const mode = () => `${workspace.currentMode()}${options.rpi === true ? '+rpi' : ''}`
					createEffect(() => {
						const hosted = active()
						if (hosted === null || loadedViewedChanges.has(hosted.sessionId)) return
						loadedViewedChanges.add(hosted.sessionId)
						const layoutOptions =
							options.foldHome === undefined
								? { cwd: hosted.cwd }
								: { cwd: hosted.cwd, foldHome: options.foldHome }
						runFork(
							loadViewedPatchHashes(hosted.sessionId, layoutOptions).pipe(
								Effect.tap((viewed) =>
									Effect.sync(() =>
										setViewedChanges((all) => ({
											...all,
											[hosted.sessionId]: { ...viewed, ...(all[hosted.sessionId] ?? {}) },
										})),
									),
								),
							),
						)
					})
					return (
						<Show
							when={router.route()._tag === 'providers'}
							fallback={
								<Show
									when={active()}
									fallback={
										<SessionPicker
											cwd={workspace.currentCwd()}
											mode={mode()}
											profile={workspace.currentProfile()}
											configuration={configuration()}
											onOpenProviders={router.showProviders}
											sessions={workspace.sessions}
											notice={workspace.notice}
											opening={workspace.opening}
											onOpen={(id) => activate(workspace.open(id), false)}
											onDelete={remove}
											onNew={(request) => activate(workspace.create(request), true)}
											onQuit={() => renderer.destroy()}
											toggles={toggles}
											setToggles={setToggles}
											onCycleTheme={cycleTheme}
											onSelectTheme={selectTheme}
										/>
									}
								>
									{(current: Accessor<HostedTuiSession>) => (
										<TuiApp
											state={current().state}
											cwd={current().cwd}
											sessionId={current().sessionId}
											mode={`${current().mode()}${options.rpi === true ? '+rpi' : ''}`}
											profile={current().profile()}
											configuration={configuration()}
											onOpenProviders={router.showProviders}
											notice={current().notice}
											targetNotice={current().targetNotice}
											compacting={current().compacting}
											initialInputFocused={focusInputOnActivation()}
											gitSnapshot={gitSnapshot}
											viewedPatchHashes={() => viewedChanges()[current().sessionId] ?? {}}
											onViewChange={(change) => {
												setViewedChanges((all) => ({
													...all,
													[current().sessionId]: markChangeViewed(
														all[current().sessionId] ?? {},
														change,
													),
												}))
												const layoutOptions =
													options.foldHome === undefined
														? { cwd: current().cwd }
														: { cwd: current().cwd, foldHome: options.foldHome }
												runFork(
													saveViewedPatchHash(
														current().sessionId,
														change.key,
														change.patchHash,
														layoutOptions,
													),
												)
											}}
											onRefreshGit={() => refreshGit(current().cwd)}
											onSubmit={current().submit}
											onCompact={current().compact}
											onInterrupt={current().interrupt}
											onStop={current().stop}
											onTargetSubmit={current().targetSubmit}
											onTargetInterrupt={current().targetInterrupt}
											onInjectSkill={current().injectSkill}
											toggles={toggles}
											setToggles={setToggles}
											onCycleTheme={cycleTheme}
											onSelectTheme={selectTheme}
											onNewSession={(request) => activate(workspace.create(request), true)}
											onConfigureModels={current().configureModels}
											onBackToSessions={router.showPicker}
											onCopySessionId={() => {
												const copied = renderer.copyToClipboardOSC52(current().sessionId)
												current().notify(copied ? 'SESSION ID COPIED' : 'CLIPBOARD UNAVAILABLE')
											}}
										/>
									)}
								</Show>
							}
						>
							<ProviderConfigPage
								configuration={configuration()}
								configExists={config() !== null}
								onClose={router.backFromProviders}
								onAuth={updateAuth}
								onInitialize={initializeConfig}
								onConfigure={updateProvider}
								onCopyUrl={(url) => renderer.copyToClipboardOSC52(url)}
							/>
						</Show>
					)
				}, renderer),
			catch: (error) => new TuiRendererError({ message: String(error) }),
		})
		yield* Effect.sync(() => renderer.start())
		if (options.prompt !== undefined) {
			const current = active()
			if (current !== null) {
				if (options.prompt.trim() === '/compact') current.compact()
				else current.submit('send', options.prompt)
			}
		}
		yield* Deferred.await(quit)
	})
