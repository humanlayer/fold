/** @jsxImportSource @opentui/solid */
import {
	launchSession,
	makeDiskSkillSource,
	deleteSession,
	listSessionSummaries,
	modeForName,
	resumeLatestSession,
	resumeSessionById,
	type LaunchModelError,
	type NoSessionToResumeError,
	type SessionToResumeNotFoundError,
} from '@humanlayer/tart-agent'
import { lookupCatalogEntry, type SessionId, type TartSession } from '@humanlayer/tart-core'
import { renderSkillContent } from '@humanlayer/tart-core'
import { ALL_FX_ON, type FxToggles } from '@humanlayer/tart-tui-theme/postfx'
import { nextThemeId, type ThemeId } from '@humanlayer/tart-tui-theme/themes'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { Cause, Deferred, Duration, Effect, Exit, Match, Schema, Scope, Stream } from 'effect'
import { batch, createSignal, Show, type Accessor } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'

import type { CliSessionOptions } from '../Run'
import { TuiApp } from './App'
import { executeRootInputAction, unexpectedActionCauseNotice, type RootInputVerb } from './Converse'
import { SessionPicker } from './SessionPicker'
import { makeSessionStateFromEntries, reduceSessionEvents, type SessionState } from './SessionState'
import { setCurrentTheme } from './ThemeState'

export class TuiRequiresTtyError extends Schema.TaggedErrorClass<TuiRequiresTtyError>()('TuiRequiresTtyError', {}) {}

export class TuiRendererError extends Schema.TaggedErrorClass<TuiRendererError>()('TuiRendererError', {
	message: Schema.String,
}) {}

export type TuiOptions = CliSessionOptions & { readonly prompt?: string }

const launchOptions = (options: TuiOptions) => ({
	cwd: options.cwd,
	...(options.tartHome === undefined ? {} : { tartHome: options.tartHome }),
	...(options.mode === undefined ? {} : { mode: modeForName(options.mode) }),
	...(options.rpi === true ? { rpi: true } : {}),
	...(options.profile === undefined ? {} : { profile: options.profile }),
	...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
	...(options.autoCompact === undefined ? {} : { autoCompact: options.autoCompact }),
	...(options.catalog === undefined ? {} : { catalog: options.catalog }),
})

type TuiSessionError = LaunchModelError | NoSessionToResumeError | SessionToResumeNotFoundError

const openSession = (options: TuiOptions): Effect.Effect<TartSession, TuiSessionError, Scope.Scope> => {
	if (options.resume === undefined) return launchSession(launchOptions(options))
	return Match.value(options.resume).pipe(
		Match.tag('latest', () => resumeLatestSession(launchOptions(options))),
		Match.tag('id', ({ sessionId }) => resumeSessionById(sessionId, launchOptions(options))),
		Match.exhaustive,
	)
}

type ActiveTuiSession = {
	readonly session: TartSession
	readonly state: Accessor<SessionState>
	readonly notice: Accessor<string | null>
	readonly targetNotice: Accessor<{ readonly agentId: string; readonly text: string } | null>
	readonly compacting: Accessor<boolean>
	readonly initialInputFocused: boolean
	readonly submit: (verb: RootInputVerb, text: string) => void
	readonly compact: () => void
	readonly interrupt: () => void
	readonly stop: () => void
	readonly targetSubmit: (agentId: string, text: string, verb: RootInputVerb) => void
	readonly targetInterrupt: (agentId: string) => void
	readonly notify: (notice: string | null) => void
	readonly notifyTarget: (notice: { readonly agentId: string; readonly text: string } | null) => void
	readonly scope: Scope.Closeable
}

export const runTui = (
	options: TuiOptions,
): Effect.Effect<void, TuiRequiresTtyError | TuiRendererError | TuiSessionError, Scope.Scope> =>
	Effect.gen(function* () {
		if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return yield* new TuiRequiresTtyError()
		const quit = yield* Deferred.make<void>()
		const parentScope = yield* Scope.Scope
		const context = yield* Effect.context<Scope.Scope>()
		const runFork = Effect.runForkWith(context)

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
		const [themeId, setThemeId] = createSignal<ThemeId>('tactical')
		const [toggles, setToggles] = createSignal<FxToggles>({
			...ALL_FX_ON,
			glow: false,
			scanlines: false,
			vignette: 'off',
		})
		const selectTheme = (id: ThemeId): void => {
			setCurrentTheme(id)
			setThemeId(id)
		}
		const cycleTheme = (): void => selectTheme(nextThemeId(themeId()))
		yield* Effect.addFinalizer(() => Effect.sync(() => renderer.destroy()))

		const makeActiveSession = (
			session: TartSession,
			initialInputFocused: boolean,
		): Effect.Effect<Omit<ActiveTuiSession, 'scope'>, never, Scope.Scope> =>
			Effect.gen(function* () {
				const activeContext = yield* Effect.context<Scope.Scope>()
				const runActiveRoot = Effect.runForkWith(activeContext)
				const runActiveFork = <A, E>(effect: Effect.Effect<A, E>): void => {
					runActiveRoot(Effect.forkScoped(effect, { startImmediately: true }))
				}
				const replay = yield* Effect.orDie(session.entries)
				const replayHead = replay.at(-1)?.seq ?? -1
				const [state, setState] = createStore(makeSessionStateFromEntries(replay, session.rootAgentId))
				const [notice, setNotice] = createSignal<string | null>(null)
				const [targetNotice, setTargetNotice] = createSignal<{
					readonly agentId: string
					readonly text: string
				} | null>(null)
				const [compacting, setCompacting] = createSignal(false)
				const submit = (verb: RootInputVerb, text: string): void => {
					setNotice(null)
					runActiveFork(executeRootInputAction(session, verb, text, setNotice))
				}
				const compact = (): void => {
					if (compacting()) return
					setCompacting(true)
					setNotice('COMPACTING')
					runActiveFork(
						session.compact().pipe(
							Effect.tap((entry) =>
								Effect.sync(() => setNotice(entry === null ? 'NOTHING TO COMPACT' : 'COMPACTED')),
							),
							Effect.catchCause((cause) =>
								Effect.sync(() => setNotice(unexpectedActionCauseNotice(cause))),
							),
							Effect.ensuring(Effect.sync(() => setCompacting(false))),
						),
					)
				}
				const interrupt = (): void => {
					setNotice('INTERRUPT REQUESTED')
					runActiveFork(
						session
							.interrupt()
							.pipe(
								Effect.catchCause((cause) =>
									Effect.sync(() => setNotice(unexpectedActionCauseNotice(cause))),
								),
							),
					)
				}
				const stop = (): void => {
					setNotice('STOP REQUESTED')
					runActiveFork(
						session
							.stop('Requested from command palette')
							.pipe(
								Effect.catchCause((cause) =>
									Effect.sync(() => setNotice(unexpectedActionCauseNotice(cause))),
								),
							),
					)
				}
				const targetSubmit = (agentId: string, text: string, verb: RootInputVerb): void => {
					setNotice(null)
					setTargetNotice({
						agentId,
						text: verb === 'send' ? 'RESUMING SUBAGENT' : 'SUBAGENT MESSAGE QUEUED',
					})
					runActiveFork(
						(verb === 'steer'
							? session
									.steer(text, { agentId: agentId as never })
									.pipe(
										Effect.catchTag('AgentNotRunningError', () =>
											session.send(text, { agentId: agentId as never }),
										),
									)
							: verb === 'interrupt-send'
								? session
										.interrupt({ agentId: agentId as never })
										.pipe(Effect.andThen(session.send(text, { agentId: agentId as never })))
								: session.send(text, { agentId: agentId as never })
						).pipe(
							Effect.tap(() => Effect.sync(() => setTargetNotice({ agentId, text: 'SUBAGENT READY' }))),
							Effect.catchCause((cause) =>
								Effect.sync(() =>
									setTargetNotice({ agentId, text: unexpectedActionCauseNotice(cause) }),
								),
							),
						),
					)
				}
				const targetInterrupt = (agentId: string): void => {
					setNotice(null)
					setTargetNotice({ agentId, text: 'SUBAGENT INTERRUPT REQUESTED' })
					runActiveFork(
						session
							.interrupt({ agentId: agentId as never })
							.pipe(
								Effect.catchCause((cause) =>
									Effect.sync(() =>
										setTargetNotice({ agentId, text: unexpectedActionCauseNotice(cause) }),
									),
								),
							),
					)
				}

				const drain = session.events(replayHead + 1).pipe(
					Stream.groupedWithin(1024, Duration.millis(16)),
					Stream.runForEach((events) =>
						Effect.sync(() => {
							const next = reduceSessionEvents(state, events, session.rootAgentId)
							batch(() => setState(reconcile(next)))
						}),
					),
					Effect.catchCause((cause) =>
						Effect.logError('TUI event stream stopped').pipe(
							Effect.annotateLogs({ session_id: session.sessionId, cause: Cause.pretty(cause) }),
						),
					),
				)
				yield* Effect.forkScoped(drain, { startImmediately: true })
				yield* Effect.yieldNow

				return {
					session,
					state: () => state,
					notice,
					targetNotice,
					compacting,
					initialInputFocused,
					submit,
					compact,
					interrupt,
					stop,
					targetSubmit,
					targetInterrupt,
					notify: setNotice,
					notifyTarget: setTargetNotice,
				}
			})

		const summariesEffect = listSessionSummaries({
			cwd: options.cwd,
			...(options.tartHome === undefined ? {} : { tartHome: options.tartHome }),
		}).pipe(
			Effect.map((discovered) =>
				discovered.map((summary) => {
					const catalogEntry =
						summary.model === null || options.catalog === undefined
							? null
							: lookupCatalogEntry(options.catalog, summary.model)
					return {
						...summary,
						contextPercent:
							summary.contextTokens === null || catalogEntry === null || catalogEntry.contextWindow <= 0
								? null
								: Math.min(100, Math.round((summary.contextTokens / catalogEntry.contextWindow) * 100)),
					}
				}),
			),
		)
		const pickerFirst = options.resume === undefined && options.prompt === undefined
		const initialSummaries = pickerFirst ? yield* summariesEffect : []
		const [summaries, setSummaries] = createSignal(initialSummaries)
		const [pickerNotice, setPickerNotice] = createSignal<string | null>(null)
		const [opening, setOpening] = createSignal(false)
		const [currentCwd, setCurrentCwd] = createSignal(options.cwd)

		const acquireActive = (
			effect: Effect.Effect<TartSession, TuiSessionError, Scope.Scope>,
			focusInput: boolean,
		): Effect.Effect<ActiveTuiSession, TuiSessionError> => {
			const childScope = Scope.forkUnsafe(parentScope)
			return Scope.provide(childScope)(
				effect.pipe(
					Effect.flatMap((session) => makeActiveSession(session, focusInput)),
					Effect.map((active) => ({ ...active, scope: childScope })),
					Effect.onError(() => Scope.close(childScope, Exit.void)),
				),
			)
		}

		const initialActive = pickerFirst ? null : yield* acquireActive(openSession(options), false)
		const [active, setActive] = createSignal<ActiveTuiSession | null>(initialActive)

		const closeCurrent = (): Effect.Effect<void> => {
			const current = active()
			return current === null ? Effect.void : Scope.close(current.scope, Exit.void)
		}

		const showPicker = (): void => {
			if (opening()) return
			setOpening(true)
			runFork(
				Effect.gen(function* () {
					yield* closeCurrent()
					yield* Effect.sync(() => setActive(null))
					const refreshed = yield* summariesEffect
					batch(() => {
						setSummaries(refreshed)
						setPickerNotice(null)
					})
				}).pipe(
					Effect.catchCause((cause) => Effect.sync(() => setPickerNotice(Cause.pretty(cause)))),
					Effect.ensuring(Effect.sync(() => setOpening(false))),
				),
			)
		}

		const activate = (
			effect: Effect.Effect<TartSession, TuiSessionError, Scope.Scope>,
			focusInput: boolean,
			cwd = currentCwd(),
		): void => {
			if (opening()) return
			setOpening(true)
			setPickerNotice(null)
			runFork(
				closeCurrent().pipe(
					Effect.tap(() => Effect.sync(() => setActive(null))),
					Effect.andThen(acquireActive(effect, focusInput)),
					Effect.tap((next) =>
						Effect.sync(() =>
							batch(() => {
								setActive(next)
								setCurrentCwd(cwd)
							}),
						),
					),
					Effect.catchCause((cause) => Effect.sync(() => setPickerNotice(Cause.pretty(cause)))),
					Effect.ensuring(Effect.sync(() => setOpening(false))),
				),
			)
		}

		const removeSession = (sessionId: SessionId): void => {
			if (opening()) return
			setOpening(true)
			setPickerNotice(null)
			runFork(
				deleteSession(sessionId, {
					cwd: options.cwd,
					...(options.tartHome === undefined ? {} : { tartHome: options.tartHome }),
				}).pipe(
					Effect.flatMap((result) =>
						summariesEffect.pipe(Effect.map((refreshed) => ({ result, refreshed }))),
					),
					Effect.tap(({ result, refreshed }) =>
						Effect.sync(() => {
							setSummaries(refreshed)
							setPickerNotice(
								!result.deleted
									? 'SESSION ALREADY REMOVED'
									: result.outputRemoved
										? 'SESSION AND STORED OUTPUT DELETED'
										: 'SESSION DELETED · STORED OUTPUT CLEANUP FAILED',
							)
						}),
					),
					Effect.catchCause((cause) => Effect.sync(() => setPickerNotice(Cause.pretty(cause)))),
					Effect.ensuring(Effect.sync(() => setOpening(false))),
				),
			)
		}

		yield* Effect.tryPromise({
			try: () =>
				render(() => {
					const mode = `${options.mode ?? 'default'}${options.rpi === true ? '+rpi' : ''}`
					return (
						<Show
							when={active()}
							fallback={
								<SessionPicker
									cwd={currentCwd()}
									mode={mode}
									profile={options.profile ?? 'default'}
									sessions={summaries}
									notice={pickerNotice}
									opening={opening}
									onOpen={(sessionId: SessionId) =>
										activate(resumeSessionById(sessionId, launchOptions(options)), false)
									}
									onDelete={removeSession}
									onNew={(cwd) =>
										activate(launchSession({ ...launchOptions(options), cwd }), true, cwd)
									}
									onQuit={() => renderer.destroy()}
									toggles={toggles}
									setToggles={setToggles}
									onCycleTheme={cycleTheme}
									onSelectTheme={selectTheme}
								/>
							}
						>
							{(current: Accessor<ActiveTuiSession>) => (
								<TuiApp
									state={current().state}
									cwd={currentCwd()}
									sessionId={current().session.sessionId}
									mode={mode}
									profile={options.profile ?? 'default'}
									notice={current().notice}
									targetNotice={current().targetNotice}
									compacting={current().compacting}
									initialInputFocused={current().initialInputFocused}
									onSubmit={current().submit}
									onCompact={current().compact}
									onInterrupt={current().interrupt}
									onStop={current().stop}
									onTargetSubmit={current().targetSubmit}
									onTargetInterrupt={current().targetInterrupt}
									onInjectSkill={(name, agentId) => {
										if (agentId === null) {
											current().notifyTarget(null)
											current().notify(`INJECTING SKILL · ${name}`)
										} else {
											current().notify(null)
											current().notifyTarget({ agentId, text: `INJECTING SKILL · ${name}` })
										}
										runFork(
											Effect.gen(function* () {
												const source = yield* makeDiskSkillSource({ cwd: currentCwd() })
												const skill = yield* source.load(name)
												yield* current().session.injectSkill(
													name,
													renderSkillContent(skill),
													agentId === null ? undefined : { agentId },
												)
												yield* Effect.sync(() => {
													if (agentId === null) current().notify(`SKILL INJECTED · ${name}`)
													else
														current().notifyTarget({
															agentId,
															text: `SKILL INJECTED · ${name}`,
														})
												})
											}).pipe(
												Effect.catchCause((cause) =>
													Effect.sync(() => {
														const text = Cause.pretty(cause)
														if (agentId === null) current().notify(text)
														else current().notifyTarget({ agentId, text })
													}),
												),
											),
										)
									}}
									toggles={toggles}
									setToggles={setToggles}
									onCycleTheme={cycleTheme}
									onSelectTheme={selectTheme}
									onNewSession={(cwd) =>
										activate(launchSession({ ...launchOptions(options), cwd }), true, cwd)
									}
									onBackToSessions={showPicker}
									onCopySessionId={() => {
										const copied = renderer.copyToClipboardOSC52(current().session.sessionId)
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
				else yield* Effect.forkScoped(current.session.send(options.prompt))
			}
		}
		yield* Deferred.await(quit)
	})
