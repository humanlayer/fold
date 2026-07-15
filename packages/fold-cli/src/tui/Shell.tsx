/** @jsxImportSource @opentui/solid */
import {
	bootstrapFoldHome,
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
import { ALL_FX_ON, type FxToggles } from '@humanlayer/fold-tui-theme/postfx'
import { nextThemeId, type ThemeId } from '@humanlayer/fold-tui-theme/themes'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { Cause, Clock, Deferred, Effect, Exit, Option, Schema, Scope } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { createEffect, createSignal, Show, type Accessor } from 'solid-js'

import { TuiApp } from './App'
import { loadGitSnapshot, type GitSnapshot } from './GitChanges'
import type { HostedTuiSession } from './HostedTuiSession'
import { openUrlInBrowser } from './OpenUrl'
import { codexAuthStoreOptions, type ProviderAuthAction, type ProviderAuthUpdate } from './ProviderAuth'
import { SessionPicker } from './SessionPicker'
import { setCurrentTheme } from './ThemeState'
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
		// Bootstrap before config loading. User-owned config and auth files are only created when absent;
		// generated schema and guide files are refreshed to match this Fold version.
		yield* bootstrapFoldHome(options.foldHome === undefined ? {} : { foldHome: options.foldHome }).pipe(
			Effect.catchCause(() => Effect.void),
		)
		// Downloads should not delay the first frame, but remain scoped to the TUI lifetime.
		yield* Effect.forkScoped(
			ensureManagedBinaries({
				foldHome: options.foldHome ?? defaultFoldHome(),
				requireManagedInstall: true,
				suppressWarnings: true,
			}).pipe(Effect.asVoid),
		)
		const configExit = yield* Effect.exit(
			loadFoldConfigOrNull(options.foldHome === undefined ? {} : { foldHome: options.foldHome }),
		)
		const config: FoldConfig | null = Exit.isSuccess(configExit) ? configExit.value : null
		const configuration: ModelConfiguration =
			config === null
				? { profiles: [], providers: [] }
				: describeModelConfiguration(config, options.catalog ?? [])
		const configNotice = Exit.isFailure(configExit)
			? `CONFIGURATION ERROR · ${Cause.pretty(configExit.cause)}`
			: config === null
				? 'NO MODEL CONFIGURATION · RUN `fold config init`, THEN EDIT ~/.fold/config.jsonc'
				: null
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
		const [toggles, setToggles] = createSignal<FxToggles>({
			...ALL_FX_ON,
			glow: false,
			scanlines: false,
			vignette: 'off',
			rollingBar: false,
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
			provider: string,
			action: ProviderAuthAction,
			update: (state: ProviderAuthUpdate) => void,
		): void => {
			const store = makeCodexAuthStore(codexAuthStoreOptions(provider, options.foldHome))
			runFork(
				Effect.gen(function* () {
					if (action === 'status') {
						update({ _tag: 'working', message: 'Checking stored credential...' })
						const token = yield* store.load
						if (Option.isNone(token))
							return update({ _tag: 'success', message: 'No Codex credential stored.' })
						const now = yield* Clock.currentTimeMillis
						return update({
							_tag: 'success',
							message: `Codex credential is ${token.value.isExpired(now) ? 'expired' : 'valid'} (expires ${new Date(token.value.expires).toISOString()}).`,
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
							Effect.sync(() => update({ _tag: 'device', url: prompt.verifyUrl, code: prompt.userCode })),
					}).pipe(Effect.provide(FetchHttpClient.layer))
					if (action === 'logout') {
						update({ _tag: 'working', message: 'Removing stored credential...' })
						yield* auth.logout
						return update({ _tag: 'success', message: 'Codex credential removed.' })
					}
					update({ _tag: 'working', message: `Starting ${action} login...` })
					yield* action === 'browser' ? auth.authenticateBrowser : auth.authenticateDevice
					update({ _tag: 'success', message: 'Codex authentication saved successfully.' })
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
					Effect.tap(() =>
						Effect.sync(() =>
							update({
								_tag: 'success',
								message:
									'Configuration initialized. Restart Fold to load config.jsonc and exported credentials.',
							}),
						),
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
			configuration,
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
		const activate = (operation: Option.Option<Effect.Effect<HostedTuiSession, unknown>>): void => {
			if (Option.isNone(operation)) return
			const token = router.beginSessionActivation()
			runFork(
				operation.value.pipe(
					Effect.tap((hosted) => Effect.sync(() => router.showSession(token, hosted.sessionId))),
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
							when={active()}
							fallback={
								<SessionPicker
									cwd={workspace.currentCwd()}
									mode={mode()}
									profile={workspace.currentProfile()}
									configuration={configuration}
									configExists={config !== null}
									onProviderAuth={updateAuth}
									onInitializeConfig={initializeConfig}
									sessions={workspace.sessions}
									notice={workspace.notice}
									opening={workspace.opening}
									onOpen={(id) => activate(workspace.open(id))}
									onDelete={remove}
									onNew={(request) => activate(workspace.create(request))}
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
									configuration={configuration}
									configExists={config !== null}
									onProviderAuth={updateAuth}
									onInitializeConfig={initializeConfig}
									notice={current().notice}
									targetNotice={current().targetNotice}
									compacting={current().compacting}
									initialInputFocused={current().initialInputFocused}
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
									onNewSession={(request) => activate(workspace.create(request))}
									onConfigureModels={current().configureModels}
									onBackToSessions={router.showPicker}
									onCopySessionId={() => {
										const copied = renderer.copyToClipboardOSC52(current().sessionId)
										current().notify(copied ? 'SESSION ID COPIED' : 'CLIPBOARD UNAVAILABLE')
									}}
								/>
							)}
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
