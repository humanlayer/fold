import {
	deleteSession,
	launchSession,
	listSessionSummaries,
	modeForName,
	resumeLatestSession,
	resumeSessionById,
	type LaunchModelError,
	type ModelConfiguration,
	type NoSessionToResumeError,
	type ProfileModeName,
	type SessionToResumeNotFoundError,
	type FoldConfig,
} from '@humanlayer/fold-agent'
import { lookupCatalogEntry, type SessionId, type FoldSession } from '@humanlayer/fold-core'
import { Cause, Duration, Effect, Match, Option, Scope } from 'effect'
import { createSignal, type Accessor } from 'solid-js'

import { makeHostedTuiSession, type HostedTuiSession, type HostedTuiSessionMetadata } from './HostedTuiSession'
import { requestToLaunchOptions } from './LaunchRequests'
import { makeLiveSessionHost } from './LiveSessionHost'
import type { NewSessionRequest } from './NewSessionModal'
import { projectSessionRows, type SessionRow } from './SessionListProjection'
import type { TuiOptions } from './TuiSessionOptions'

const launchOptions = (options: TuiOptions) => ({
	cwd: options.cwd,
	...(options.foldHome === undefined ? {} : { foldHome: options.foldHome }),
	...(options.mode === undefined ? {} : { mode: modeForName(options.mode) }),
	...(options.rpi === true ? { rpi: true } : {}),
	...(options.modelSelection !== undefined
		? { modelSelection: options.modelSelection }
		: options.profile === undefined
			? {}
			: { profile: options.profile }),
	...(options.autoCompact === undefined ? {} : { autoCompact: options.autoCompact }),
	...(options.catalog === undefined ? {} : { catalog: options.catalog }),
})

const initialSession = (options: TuiOptions) => {
	if (options.resume === undefined) return launchSession(launchOptions(options))
	return Match.value(options.resume).pipe(
		Match.tag('latest', () => resumeLatestSession(launchOptions(options))),
		Match.tag('id', ({ sessionId }) => resumeSessionById(sessionId, launchOptions(options))),
		Match.exhaustive,
	)
}

export type TuiInitialSessionError = LaunchModelError | NoSessionToResumeError | SessionToResumeNotFoundError

export type TuiSessionWorkspace = {
	readonly sessions: Accessor<ReadonlyArray<SessionRow>>
	readonly opening: Accessor<boolean>
	readonly notice: Accessor<string | null>
	readonly currentCwd: Accessor<string>
	readonly currentProfile: Accessor<string>
	readonly currentMode: Accessor<ProfileModeName>
	readonly get: (sessionId: SessionId) => HostedTuiSession | null
	readonly openInitial: Effect.Effect<HostedTuiSession, TuiInitialSessionError>
	readonly open: (sessionId: SessionId) => Option.Option<Effect.Effect<HostedTuiSession, unknown>>
	readonly create: (request: NewSessionRequest) => Option.Option<Effect.Effect<HostedTuiSession, LaunchModelError>>
	readonly delete: (sessionId: SessionId) => Option.Option<Effect.Effect<void>>
}

export const makeTuiSessionWorkspace = (options: {
	readonly tui: TuiOptions
	readonly configuration: ModelConfiguration
	readonly config: FoldConfig | null
	readonly configNotice: string | null
	readonly loadSummariesOnStart: boolean
}): Effect.Effect<TuiSessionWorkspace, never, Scope.Scope> =>
	Effect.gen(function* () {
		const parentScope = yield* Scope.Scope
		const runRoot = Effect.runForkWith(yield* Effect.context<Scope.Scope>())
		const run = <A, E>(effect: Effect.Effect<A, E>): void => {
			runRoot(Effect.forkScoped(effect, { startImmediately: true }))
		}
		const cwds = new Set([options.tui.cwd])
		const cwdBySession = new Map<SessionId, string>()
		const loadSummaries = Effect.suspend(() =>
			Effect.forEach([...cwds], (cwd) =>
				listSessionSummaries({
					cwd,
					...(options.tui.foldHome === undefined ? {} : { foldHome: options.tui.foldHome }),
				}).pipe(
					Effect.tap((rows) =>
						Effect.sync(() => rows.forEach((row) => cwdBySession.set(row.sessionId, cwd))),
					),
				),
			).pipe(
				Effect.map((groups) => {
					const byId = new Map(groups.flat().map((summary) => [summary.sessionId, summary]))
					return [...byId.values()]
						.sort((left, right) => right.mtimeMs - left.mtimeMs)
						.map((summary) => {
							const entry =
								summary.model === null || options.tui.catalog === undefined
									? null
									: lookupCatalogEntry(options.tui.catalog, summary.model)
							return {
								...summary,
								contextPercent:
									summary.contextTokens === null || entry === null || entry.contextWindow <= 0
										? null
										: Math.min(
												100,
												Math.round((summary.contextTokens / entry.contextWindow) * 100),
											),
							}
						})
				}),
			),
		)
		const [summaries, setSummaries] = createSignal<ReadonlyArray<SessionRow>>(
			options.loadSummariesOnStart ? yield* loadSummaries : [],
		)
		const [notice, setNotice] = createSignal<string | null>(options.configNotice)
		const [opening, setOpening] = createSignal(false)
		const [currentCwd, setCurrentCwd] = createSignal(options.tui.cwd)
		const [currentProfile, setCurrentProfile] = createSignal(options.tui.profile ?? 'default')
		const [currentMode, setCurrentMode] = createSignal<ProfileModeName>(options.tui.mode ?? 'default')
		let refreshScheduled = false
		const refresh = (): void => {
			if (refreshScheduled) return
			refreshScheduled = true
			run(
				Effect.sleep(Duration.millis(50)).pipe(
					Effect.andThen(loadSummaries),
					Effect.tap((value) => Effect.sync(() => setSummaries(value))),
					Effect.catchCause((cause) => Effect.logWarning(Cause.pretty(cause))),
					Effect.ensuring(Effect.sync(() => (refreshScheduled = false))),
				),
			)
		}
		const host = makeLiveSessionHost<HostedTuiSession>(parentScope, (hosted) => ({
			sessionId: hosted.sessionId,
			phase: 'live',
			status: hosted.state().status,
		}))
		yield* Effect.addFinalizer(() => host.closeAll)
		const acquire = <E>(
			session: Effect.Effect<FoldSession, E, Scope.Scope>,
			metadata: HostedTuiSessionMetadata,
			focused: boolean,
		) =>
			session.pipe(
				Effect.flatMap((value) =>
					makeHostedTuiSession(value, {
						metadata,
						initialInputFocused: focused,
						config: options.config,
						configNotice: options.configNotice,
						onDurableSummaryChange: refresh,
					}),
				),
			)
		const finish = (hosted: HostedTuiSession) =>
			loadSummaries.pipe(
				Effect.tap((value) => Effect.sync(() => setSummaries(value))),
				Effect.tap(() =>
					Effect.sync(() => {
						setCurrentCwd(hosted.cwd)
						setCurrentProfile(hosted.profile())
						setCurrentMode(hosted.mode())
					}),
				),
				Effect.as(hosted),
			)
		const observe = <A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> =>
			Effect.sync(() => {
				setOpening(true)
				setNotice(null)
			}).pipe(
				Effect.andThen(operation),
				Effect.catchCause((cause) =>
					Effect.sync(() => setNotice(Cause.pretty(cause))).pipe(Effect.andThen(Effect.failCause(cause))),
				),
				Effect.ensuring(Effect.sync(() => setOpening(false))),
			)
		const reserve = <A, E>(operation: Effect.Effect<A, E>): Option.Option<Effect.Effect<A, E>> => {
			if (opening()) return Option.none()
			setOpening(true)
			setNotice(null)
			return Option.some(
				operation.pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() => setNotice(Cause.pretty(cause))).pipe(Effect.andThen(Effect.failCause(cause))),
					),
					Effect.ensuring(Effect.sync(() => setOpening(false))),
				),
			)
		}
		const openInitial = observe(
			host
				.register(
					acquire(
						initialSession(options.tui),
						{
							cwd: options.tui.cwd,
							profile: options.tui.profile ?? 'default',
							mode: options.tui.mode ?? 'default',
						},
						false,
					),
				)
				.pipe(Effect.flatMap(finish)),
		)
		const open = (sessionId: SessionId) => {
			const row = projectSessionRows(summaries(), host.snapshots()).find((item) => item.sessionId === sessionId)
			const metadata: HostedTuiSessionMetadata = {
				cwd: cwdBySession.get(sessionId) ?? currentCwd(),
				profile: row?.profile ?? 'default',
				mode: row?.mode === 'rlm' ? 'rlm' : 'default',
			}
			cwds.add(metadata.cwd)
			return reserve(
				host
					.open(
						sessionId,
						acquire(
							resumeSessionById(sessionId, launchOptions({ ...options.tui, cwd: metadata.cwd })),
							metadata,
							false,
						),
					)
					.pipe(Effect.flatMap(finish)),
			)
		}
		const create = (request: NewSessionRequest) => {
			const next = requestToLaunchOptions(options.tui, request)
			const metadata: HostedTuiSessionMetadata = {
				cwd: request.cwd,
				profile: request._tag === 'profile' ? request.profile : 'direct',
				mode:
					request._tag === 'profile'
						? (options.configuration.profiles.find((profile) => profile.name === request.profile)?.mode ??
							'default')
						: request.mode,
			}
			cwds.add(metadata.cwd)
			return reserve(
				host.register(acquire(launchSession(launchOptions(next)), metadata, true)).pipe(Effect.flatMap(finish)),
			)
		}
		const remove = (sessionId: SessionId) =>
			reserve(
				Effect.gen(function* () {
					const cwd = host.get(sessionId)?.cwd ?? cwdBySession.get(sessionId) ?? options.tui.cwd
					yield* host.close(sessionId)
					const result = yield* deleteSession(sessionId, {
						cwd,
						...(options.tui.foldHome === undefined ? {} : { foldHome: options.tui.foldHome }),
					})
					setSummaries(yield* loadSummaries)
					setNotice(
						!result.deleted
							? 'SESSION ALREADY REMOVED'
							: result.outputRemoved
								? 'SESSION AND STORED OUTPUT DELETED'
								: 'SESSION DELETED · STORED OUTPUT CLEANUP FAILED',
					)
				}),
			)
		return {
			sessions: () => projectSessionRows(summaries(), host.snapshots()),
			opening,
			notice,
			currentCwd,
			currentProfile,
			currentMode,
			get: host.get,
			openInitial,
			open,
			create,
			delete: remove,
		}
	})
