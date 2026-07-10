import { join } from 'node:path'

import {
	bootstrapTartHome,
	defaultTartHome,
	ensureManagedBinaries,
	launchSession,
	modeForName,
	resumeLatestSession,
	resumeSessionById,
	sessionLogPathFor,
	type AutoCompactConfig,
	type LaunchModelError,
	type ModelSelection,
	type NoSessionToResumeError,
	type SessionToResumeNotFoundError,
	type TartModeName,
} from '@humanlayer/tart-agent'
import { makeCodexAuthStore } from '@humanlayer/tart-codex'
import type {
	ActiveModel,
	AgentFinishedLogEntry,
	LogEntry,
	ModelCatalogEntry,
	SessionId,
	TartSession,
} from '@humanlayer/tart-core'
import { Cause, Clock, Effect, Exit, Fiber, Option, Stream, type Scope } from 'effect'

import { runInteractive } from './Readline'
import type { CredentialSummary, OutputRenderer, ResumeCommandFlag, SessionHeader } from './Renderer'

/**
 * What `--resume` selected: the newest session log for this project, or one exact id. Absent means a
 * fresh session.
 */
export type ResumeTarget = { readonly _tag: 'latest' } | { readonly _tag: 'id'; readonly sessionId: SessionId }

/** Shared options for opening a CLI-backed tart session. */
export type CliSessionOptions = {
	readonly cwd: string
	readonly tartHome?: string
	/** Selected agent mode. Absent keeps tart-agent's default (the full coding mode). */
	readonly mode?: TartModeName
	/** Install the RPI specialist subagents alongside the selected mode's roster (`--rpi`). */
	readonly rpi?: boolean
	/** Named profile from config.profiles (`--profile`): its roles apply, and its pinned mode unless --mode is set. */
	readonly profile?: string
	readonly modelSelection?: ModelSelection
	readonly resume?: ResumeTarget
	readonly autoCompact?: AutoCompactConfig
	/**
	 * Model catalog entries loaded once per CLI invocation (Commands.ts) and threaded here so the
	 * launch does not load a second time; the same entries back the renderer's usage table.
	 */
	readonly catalog?: ReadonlyArray<ModelCatalogEntry>
}

/** Options for one non-interactive `--prompt` run. */
export type PromptRunOptions = CliSessionOptions & {
	readonly prompt: string
}

/** Options for an interactive readline session. */
export type InteractiveRunOptions = CliSessionOptions

type OpenedSession = {
	readonly session: TartSession
	readonly mode: 'new' | 'resumed'
	readonly logPath: string
}

type OpenSessionError = LaunchModelError | SessionToResumeNotFoundError | NoSessionToResumeError

const launchOptions = (options: CliSessionOptions) => ({
	cwd: options.cwd,
	...(options.tartHome === undefined ? {} : { tartHome: options.tartHome }),
	...(options.mode === undefined ? {} : { mode: modeForName(options.mode) }),
	...(options.rpi === true ? { rpi: true } : {}),
	...(options.profile === undefined ? {} : { profile: options.profile }),
	...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
	...(options.autoCompact === undefined ? {} : { autoCompact: options.autoCompact }),
	...(options.catalog === undefined ? {} : { catalog: options.catalog }),
})

/** Start fresh, resume the project's newest log, or adopt one exact session id. */
const openSessionFor = (options: CliSessionOptions): Effect.Effect<TartSession, OpenSessionError, Scope.Scope> => {
	if (options.resume === undefined) return launchSession(launchOptions(options))

	return options.resume._tag === 'latest'
		? resumeLatestSession(launchOptions(options))
		: resumeSessionById(options.resume.sessionId, launchOptions(options))
}

const openSession = (options: CliSessionOptions): Effect.Effect<OpenedSession, OpenSessionError, Scope.Scope> =>
	Effect.gen(function* () {
		const session = yield* openSessionFor(options)
		const logPath = sessionLogPathFor(session.sessionId, {
			cwd: options.cwd,
			...(options.tartHome === undefined ? {} : { tartHome: options.tartHome }),
		})

		return {
			session,
			logPath,
			mode: options.resume === undefined ? 'new' : 'resumed',
		}
	})

const activeModelFromEntries = (entries: ReadonlyArray<LogEntry>, rootAgentId: string): ActiveModel | null => {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]
		if (entry === undefined || entry.agentId !== rootAgentId) continue
		if (entry._tag === 'model-change' || entry._tag === 'agent_started') return entry.model
	}

	return null
}

const credentialSummary = (model: ActiveModel | null, options: CliSessionOptions): Effect.Effect<CredentialSummary> =>
	Effect.gen(function* () {
		if (model === null) return { _tag: 'unknown', detail: 'no active model row found in the session log' }

		if (model.providerKind === 'codex') {
			const store = makeCodexAuthStore({
				providerId: model.providerId,
				...(options.tartHome === undefined ? {} : { path: join(options.tartHome, 'auth.json') }),
			})
			const token = yield* store.load
			if (Option.isNone(token)) return { _tag: 'missing', detail: `entry "${model.providerId}" in ${store.path}` }

			const now = yield* Clock.currentTimeMillis
			const expiry = token.value.isExpired(now) ? 'expired; will refresh on first request' : 'valid'
			return { _tag: 'found', detail: `${expiry} entry "${model.providerId}" in ${store.path}` }
		}

		return { _tag: 'found', detail: `API key resolved for provider "${model.providerId}"` }
	})

/**
 * The header's agent-mode label: non-default modes print their name, and an enabled RPI roster is
 * always visible as a `+rpi` suffix - including `default+rpi`, where the default mode alone would
 * print no mode line at all.
 */
const agentModeLabel = (options: CliSessionOptions): string | undefined => {
	const mode = options.mode ?? 'default'
	if (options.rpi === true) return `${mode}+rpi`

	return mode === 'default' ? undefined : mode
}

const compactResumeFlags = (autoCompact: AutoCompactConfig | undefined): ReadonlyArray<ResumeCommandFlag> => {
	if (autoCompact === undefined) return []
	if (!autoCompact.enabled) return [{ name: 'disable-auto-compact' }]

	return [
		{ name: 'auto-compact' },
		...(autoCompact.thresholdTokens === undefined
			? []
			: [{ name: 'compaction-threshold', value: String(autoCompact.thresholdTokens) }]),
		...(autoCompact.reserveTokens === undefined
			? []
			: [{ name: 'compaction-reserve-tokens', value: String(autoCompact.reserveTokens) }]),
		...(autoCompact.keepRecentTokens === undefined
			? []
			: [{ name: 'compaction-keep-recent-tokens', value: String(autoCompact.keepRecentTokens) }]),
		...(autoCompact.compactionPrompt === undefined
			? []
			: [{ name: 'compaction-prompt', value: autoCompact.compactionPrompt }]),
	]
}

export const resumeFlagsFor = (options: CliSessionOptions): ReadonlyArray<ResumeCommandFlag> => [
	...(options.cwd === process.cwd() ? [] : [{ name: 'cwd', value: options.cwd }]),
	...(options.tartHome === undefined ? [] : [{ name: 'tart-home', value: options.tartHome }]),
	...(options.mode === undefined ? [] : [{ name: 'mode', value: options.mode }]),
	...(options.rpi === true ? [{ name: 'rpi' }] : []),
	...(options.profile === undefined ? [] : [{ name: 'profile', value: options.profile }]),
	...(options.modelSelection?.role === undefined ? [] : [{ name: 'role', value: options.modelSelection.role }]),
	...(options.modelSelection?.provider === undefined
		? []
		: [{ name: 'provider', value: options.modelSelection.provider }]),
	...(options.modelSelection?.model === undefined ? [] : [{ name: 'model', value: options.modelSelection.model }]),
	...(options.modelSelection?.reasoning === undefined
		? []
		: [{ name: 'reasoning', value: options.modelSelection.reasoning }]),
	...compactResumeFlags(options.autoCompact),
]

const sessionHeader = (opened: OpenedSession, options: CliSessionOptions): Effect.Effect<SessionHeader> =>
	Effect.gen(function* () {
		const entries = yield* opened.session.entries
		const model = activeModelFromEntries(entries, opened.session.rootAgentId)
		const credential = yield* credentialSummary(model, options)
		const agentMode = agentModeLabel(options)

		return {
			sessionId: opened.session.sessionId,
			cwd: options.cwd,
			logPath: opened.logPath,
			mode: opened.mode,
			...(agentMode === undefined ? {} : { agentMode }),
			...(options.profile === undefined ? {} : { profile: options.profile }),
			resumeFlags: resumeFlagsFor(options),
			model,
			credential,
		}
	})

const renderLiveEvents = (
	session: TartSession,
	renderer: OutputRenderer,
): Effect.Effect<Fiber.Fiber<void>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const entries = yield* session.entries
		const fromSeq = entries.length === 0 ? 0 : (entries.at(-1)?.seq ?? -1) + 1
		const render = session.events(fromSeq).pipe(
			Stream.runForEach(renderer.renderEvent),
			Effect.catchCause(() => Effect.void),
		)
		const fiber = yield* Effect.forkScoped(render, { startImmediately: true })
		yield* Effect.yieldNow
		return fiber
	})

const withProcessSignals = <A, E, R>(
	session: TartSession,
	renderer: OutputRenderer,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			let fired = false
			const handler = (): void => {
				if (fired) return
				fired = true
				Effect.runFork(
					renderer
						.renderNote('interrupt requested; saving session state')
						.pipe(Effect.andThen(session.interrupt())),
				)
			}
			process.on('SIGINT', handler)
			process.on('SIGTERM', handler)
			return handler
		}),
		() => effect,
		(handler) =>
			Effect.sync(() => {
				process.off('SIGINT', handler)
				process.off('SIGTERM', handler)
			}),
	)

/**
 * Synchronous first-run bootstrap, ahead of the session open so the launch's config load finds the
 * layout: `~/.tart` with a starter `config.jsonc` (when absent), an empty 0600 `auth.json` (when
 * absent), and the regenerated `config.schema.json` + `TART_INFO.md`. Never fails a run - a broken
 * home surfaces as the launch's own config error moments later.
 */
const bootstrapForRun = (options: CliSessionOptions): Effect.Effect<void> =>
	bootstrapTartHome(options.tartHome === undefined ? {} : { tartHome: options.tartHome }).pipe(
		Effect.asVoid,
		Effect.catchCause(() => Effect.void),
	)

const forkStartupEnsures = (options: CliSessionOptions, renderer: OutputRenderer): Effect.Effect<void> =>
	Effect.forkDetach(
		Effect.gen(function* () {
			const statuses = yield* ensureManagedBinaries({
				tartHome: options.tartHome ?? defaultTartHome(),
				requireManagedInstall: true,
				suppressWarnings: true,
			})
			yield* Effect.forEach(
				statuses.filter((status) => status.resolution === 'installed-now'),
				(status) => renderer.renderNote(`installed ${status.name} into ${status.path ?? 'the tart bin dir'}`),
			)
		}),
	).pipe(Effect.asVoid)

/** Open a session, print its header, and run one CI-friendly prompt. */
export const runPrompt = (
	options: PromptRunOptions,
	renderer: OutputRenderer,
): Effect.Effect<AgentFinishedLogEntry, OpenSessionError, Scope.Scope> =>
	Effect.gen(function* () {
		yield* bootstrapForRun(options)
		const opened = yield* openSession(options)
		yield* renderer.renderHeader(yield* sessionHeader(opened, options))
		const renderFiber = yield* renderLiveEvents(opened.session, renderer)
		yield* forkStartupEnsures(options, renderer)
		const finished = yield* withProcessSignals(
			opened.session,
			renderer,
			opened.session.send(options.prompt).pipe(
				Effect.orDie,
				Effect.onExit((exit) =>
					Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) ? opened.session.interrupt() : Effect.void,
				),
			),
		)
		yield* Effect.yieldNow
		yield* renderer.renderFinish(finished)
		yield* Fiber.interrupt(renderFiber)
		return finished
	})

/** Open a session and run the temporary readline interface (not the future OpenTUI). */
export const runReadline = (
	options: InteractiveRunOptions,
	renderer: OutputRenderer,
): Effect.Effect<void, OpenSessionError, Scope.Scope> =>
	Effect.gen(function* () {
		yield* bootstrapForRun(options)
		const opened = yield* openSession(options)
		yield* renderer.renderHeader(yield* sessionHeader(opened, options))
		const renderFiber = yield* renderLiveEvents(opened.session, renderer)
		yield* forkStartupEnsures(options, renderer)
		yield* runInteractive(opened.session, renderer)
		yield* Fiber.interrupt(renderFiber)
	})
