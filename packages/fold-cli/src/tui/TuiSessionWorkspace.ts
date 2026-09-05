import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
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
import { layerLiveIdFactory, lookupCatalogEntry, type SessionId, type FoldSession } from '@humanlayer/fold-core'
import { Cause, Duration, Effect, type FileSystem, Match, Option, Scope } from 'effect'
import { createSignal, type Accessor } from 'solid-js'

import { contextUsedPercentForDisplay, contextWindowLimitForDisplay } from '../ContextWindow'
import { makeHostedTuiSession, type HostedTuiSession, type HostedTuiSessionMetadata } from './HostedTuiSession'
import { requestToLaunchOptions, sessionToLaunchOptions } from './LaunchRequests'
import { makeLiveSessionHost } from './LiveSessionHost'
import type { NewSessionRequest } from './NewSessionModal'
import { projectSessionRows, type SessionRow } from './SessionListProjection'
import type { TuiOptions } from './TuiSessionOptions'

type Mutable<Type> = { -readonly [Key in keyof Type]: Type[Key] }

const launchOptions = (options: TuiOptions) => {
	const launch: Mutable<Parameters<typeof launchSession>[0]> = { cwd: options.cwd }
	if (options.foldHome !== undefined) launch.foldHome = options.foldHome
	if (options.mode !== undefined) launch.mode = modeForName(options.mode)
	if (options.rpi === true) launch.rpi = true
	if (options.modelSelection !== undefined) launch.modelSelection = options.modelSelection
	else if (options.profile !== undefined) launch.profile = options.profile
	if (options.autoCompact !== undefined) launch.autoCompact = options.autoCompact
	if (options.catalog !== undefined) launch.catalog = options.catalog
	return launch
}

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
	readonly config: Accessor<FoldConfig | null> | FoldConfig | null
	readonly configNotice: string | null
	readonly loadSummariesOnStart: boolean
}): Effect.Effect<TuiSessionWorkspace, never, Scope.Scope | FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const parentScope = yield* Scope.Scope
		const configOption = options.config
		const currentConfig: Accessor<FoldConfig | null> = () =>
			typeof configOption === 'function' ? configOption() : configOption
		const runRoot = Effect.runForkWith(yield* Effect.context<Scope.Scope>())
		const run = <A, E>(effect: Effect.Effect<A, E>): void => {
			runRoot(Effect.forkScoped(effect, { startImmediately: true }))
		}
		const cwds = new Set([options.tui.cwd])
		const cwdBySession = new Map<SessionId, string>()
		const loadSummaries = Effect.suspend(() =>
			Effect.forEach([...cwds], (cwd) => {
				const summaryOptions: Mutable<NonNullable<Parameters<typeof listSessionSummaries>[0]>> = { cwd }
				if (options.tui.foldHome !== undefined) summaryOptions.foldHome = options.tui.foldHome
				return listSessionSummaries(summaryOptions).pipe(
					Effect.tap((rows) =>
						Effect.sync(() => rows.forEach((row) => cwdBySession.set(row.sessionId, cwd))),
					),
				)
			}).pipe(
				Effect.map((groups) => {
					const byId = new Map(groups.flat().map((summary) => [summary.sessionId, summary]))
					return [...byId.values()]
						.sort((left, right) => right.mtimeMs - left.mtimeMs)
						.map((summary) => {
							const entry =
								summary.model === null || options.tui.catalog === undefined
									? null
									: lookupCatalogEntry(options.tui.catalog, summary.model)
							const contextWindow =
								summary.model === null || entry === null || entry.contextWindow <= 0
									? null
									: contextWindowLimitForDisplay(summary.model, entry.contextWindow)
							return {
								...summary,
								contextPercent:
									summary.contextTokens === null || summary.model === null || contextWindow === null
										? null
										: contextUsedPercentForDisplay(
												summary.contextTokens,
												summary.model,
												contextWindow,
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
					Effect.provide(NodeFileSystem.layer),
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
			session: Effect.Effect<FoldSession, E, Scope.Scope | FileSystem.FileSystem>,
			metadata: HostedTuiSessionMetadata,
			focused: boolean,
		) =>
			session.pipe(
				Effect.provide(NodeFileSystem.layer),
				Effect.flatMap((value) => {
					const hostedOptions: Mutable<Parameters<typeof makeHostedTuiSession>[1]> = {
						metadata,
						initialInputFocused: focused,
						config: currentConfig,
						configNotice: options.configNotice,
						onDurableSummaryChange: refresh,
					}
					if (options.tui.foldHome !== undefined) hostedOptions.foldHome = options.tui.foldHome
					if (options.tui.catalog !== undefined) hostedOptions.catalog = options.tui.catalog
					if (options.tui.rpi === true) hostedOptions.rpi = true
					return makeHostedTuiSession(value, hostedOptions)
				}),
			)
		const finish = (hosted: HostedTuiSession) =>
			loadSummaries.pipe(
				Effect.provide(NodeFileSystem.layer),
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
						initialSession(options.tui).pipe(Effect.provide(layerLiveIdFactory)),
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
			const resumeOptions = row === undefined ? options.tui : sessionToLaunchOptions(options.tui, row)
			return reserve(
				host
					.open(
						sessionId,
						acquire(
							resumeSessionById(sessionId, launchOptions({ ...resumeOptions, cwd: metadata.cwd })),
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
				host
					.register(
						acquire(
							launchSession(launchOptions(next)).pipe(Effect.provide(layerLiveIdFactory)),
							metadata,
							true,
						),
					)
					.pipe(Effect.flatMap(finish)),
			)
		}
		const remove = (sessionId: SessionId) =>
			reserve(
				Effect.gen(function* () {
					const cwd = host.get(sessionId)?.cwd ?? cwdBySession.get(sessionId) ?? options.tui.cwd
					yield* host.close(sessionId)
					const deleteOptions: Mutable<NonNullable<Parameters<typeof deleteSession>[1]>> = { cwd }
					if (options.tui.foldHome !== undefined) deleteOptions.foldHome = options.tui.foldHome
					const result = yield* deleteSession(sessionId, deleteOptions)
					setSummaries(yield* loadSummaries)
					setNotice(
						!result.deleted
							? 'SESSION ALREADY REMOVED'
							: result.outputRemoved
								? 'SESSION AND STORED OUTPUT DELETED'
								: 'SESSION DELETED · STORED OUTPUT CLEANUP FAILED',
					)
				}).pipe(Effect.provide(NodeFileSystem.layer)),
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
