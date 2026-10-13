import { join } from 'node:path'

import {
	bootstrapFoldHome,
	defaultFoldHome,
	ensureManagedBinaries,
	type ManagedBinaries,
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
	type FoldModeName,
	type OutputStore,
	type Photon,
} from '@humanlayer/fold-agent'
import { CodexAuthStore, layerCodexAuthStore, type CodexAuthStoreOptions } from '@humanlayer/fold-codex'
import type {
	ActiveModel,
	AgentFinishedLogEntry,
	Ids,
	LogEntry,
	ModelCatalogEntry,
	SessionId,
	FoldSession,
} from '@humanlayer/fold-core'
import {
	Array as Arr,
	Data,
	Match,
	Predicate,
	Cause,
	Clock,
	Duration,
	Effect,
	Exit,
	Fiber,
	type FileSystem,
	Option,
	type Path,
	Stream,
	type Scope,
} from 'effect'
import type { HttpClient } from 'effect/http'
import type { ChildProcessSpawner } from 'effect/process'

import { CredentialSummary, type OutputRenderer, type ResumeCommandFlag, type SessionHeader } from './Renderer'

/**
 * What `--resume` selected: the newest session log for this project, or one exact id. Absent means a
 * fresh session.
 */
export type ResumeTarget = Data.TaggedEnum<{ latest: {}; id: { readonly sessionId: SessionId } }>
export const ResumeTarget = Data.taggedEnum<ResumeTarget>()

/** Shared options for opening a CLI-backed fold session. */
export type CliSessionOptions = {
	readonly cwd: string
	readonly foldHome?: string
	/** Selected agent mode. Absent keeps fold-agent's default (the full coding mode). */
	readonly mode?: FoldModeName
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
	/**
	 * How long the run waits for background agents (and the notification turns they trigger) after
	 * the prompt's own turn ends, before stopping them. Defaults to {@link DEFAULT_BACKGROUND_TIMEOUT}.
	 */
	readonly backgroundTimeout?: Duration.Input
}

/** Default cap on a headless run's wait for background agents. */
export const DEFAULT_BACKGROUND_TIMEOUT: Duration.Input = Duration.minutes(10)

type OpenedSession = {
	readonly session: FoldSession<
		| FileSystem.FileSystem
		| Path.Path
		| ChildProcessSpawner.ChildProcessSpawner
		| OutputStore
		| Photon
		| HttpClient.HttpClient
	>
	readonly mode: 'new' | 'resumed'
	readonly logPath: string
}

type OpenSessionError = LaunchModelError | SessionToResumeNotFoundError | NoSessionToResumeError

type Mutable<Type> = { -readonly [Key in keyof Type]: Type[Key] }

const launchOptions = (options: CliSessionOptions) => {
	const launch: Mutable<Parameters<typeof launchSession>[0]> = { cwd: options.cwd }
	if (options.foldHome !== undefined) launch.foldHome = options.foldHome
	if (options.mode !== undefined) launch.mode = modeForName(options.mode)
	if (options.rpi === true) launch.rpi = true
	if (options.profile !== undefined) launch.profile = options.profile
	if (options.modelSelection !== undefined) launch.modelSelection = options.modelSelection
	if (options.autoCompact !== undefined) launch.autoCompact = options.autoCompact
	if (options.catalog !== undefined) launch.catalog = options.catalog
	return launch
}

/** Start fresh, resume the project's newest log, or adopt one exact session id. */
const openSessionFor = (
	options: CliSessionOptions,
): Effect.Effect<
	FoldSession<
		| FileSystem.FileSystem
		| Path.Path
		| ChildProcessSpawner.ChildProcessSpawner
		| OutputStore
		| Photon
		| HttpClient.HttpClient
	>,
	OpenSessionError,
	| Scope.Scope
	| Ids
	| FileSystem.FileSystem
	| Path.Path
	| ChildProcessSpawner.ChildProcessSpawner
	| Photon
	| HttpClient.HttpClient
> => {
	if (options.resume === undefined) return launchSession(launchOptions(options))

	return Match.valueTags(options.resume, {
		latest: () => resumeLatestSession(launchOptions(options)),
		id: ({ sessionId }) => resumeSessionById(sessionId, launchOptions(options)),
	})
}

const openSession = (
	options: CliSessionOptions,
): Effect.Effect<
	OpenedSession,
	OpenSessionError,
	| Scope.Scope
	| Ids
	| FileSystem.FileSystem
	| Path.Path
	| ChildProcessSpawner.ChildProcessSpawner
	| Photon
	| HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const session = yield* openSessionFor(options)
		const logOptions: Mutable<NonNullable<Parameters<typeof sessionLogPathFor>[1]>> = { cwd: options.cwd }
		if (options.foldHome !== undefined) logOptions.foldHome = options.foldHome
		const logPath = sessionLogPathFor(session.sessionId, logOptions)

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
		if (Predicate.isTagged(entry, 'model-change') || Predicate.isTagged(entry, 'agent_started')) return entry.model
	}

	return null
}

/** Summarize a stored Codex credential: its provider's entry in the fold home's auth document. */
const codexCredentialSummary = (providerId: string): Effect.Effect<CredentialSummary, never, CodexAuthStore> =>
	Effect.gen(function* () {
		const store = yield* CodexAuthStore
		const token = yield* store.load
		if (Option.isNone(token)) {
			return CredentialSummary.missing({ detail: `entry "${providerId}" in ${store.path}` })
		}

		const now = yield* Clock.currentTimeMillis
		const expiry = token.value.isExpired(now) ? 'expired; will refresh on first request' : 'valid'
		return CredentialSummary.found({ detail: `${expiry} entry "${providerId}" in ${store.path}` })
	})

const credentialSummary = (
	model: ActiveModel | null,
	options: CliSessionOptions,
): Effect.Effect<CredentialSummary, never, FileSystem.FileSystem> => {
	if (model === null)
		return Effect.succeed(CredentialSummary.unknown({ detail: 'no active model row found in the session log' }))
	if (model.providerKind !== 'codex') {
		return Effect.succeed(
			CredentialSummary.found({ detail: `API key resolved for provider "${model.providerId}"` }),
		)
	}

	const authStoreOptions: CodexAuthStoreOptions =
		options.foldHome === undefined
			? { providerId: model.providerId }
			: { providerId: model.providerId, path: join(options.foldHome, 'auth.json') }
	return codexCredentialSummary(model.providerId).pipe(Effect.provide(layerCodexAuthStore(authStoreOptions)))
}

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

/** A `--name value` resume flag, present only when the value is. */
const valueFlag = (name: string, value: string | undefined): Option.Option<ResumeCommandFlag> =>
	Option.map(Option.fromUndefinedOr(value), (present) => ({ name, value: present }))

/** A bare `--name` resume flag, present only when switched on. */
const switchFlag = (name: string, on: boolean): Option.Option<ResumeCommandFlag> =>
	Option.liftPredicate({ name }, () => on)

const compactResumeFlags = (autoCompact: AutoCompactConfig | undefined): ReadonlyArray<ResumeCommandFlag> => {
	if (autoCompact === undefined) return []
	if (!autoCompact.enabled) return [{ name: 'disable-auto-compact' }]

	return Arr.getSomes([
		switchFlag('auto-compact', true),
		valueFlag('compaction-threshold', autoCompact.thresholdTokens?.toString()),
		valueFlag('compaction-reserve-tokens', autoCompact.reserveTokens?.toString()),
		valueFlag('compaction-keep-recent-tokens', autoCompact.keepRecentTokens?.toString()),
		valueFlag('compaction-prompt', autoCompact.compactionPrompt),
	])
}

export const resumeFlagsFor = (options: CliSessionOptions): ReadonlyArray<ResumeCommandFlag> => [
	...Arr.getSomes([
		valueFlag('cwd', options.cwd === process.cwd() ? undefined : options.cwd),
		valueFlag('fold-home', options.foldHome),
		valueFlag('mode', options.mode),
		switchFlag('rpi', options.rpi === true),
		valueFlag('profile', options.profile),
		valueFlag('role', options.modelSelection?.role),
		valueFlag('provider', options.modelSelection?.provider),
		valueFlag('model', options.modelSelection?.model),
		valueFlag('reasoning', options.modelSelection?.reasoning),
	]),
	...compactResumeFlags(options.autoCompact),
]

const sessionHeader = (
	opened: OpenedSession,
	options: CliSessionOptions,
): Effect.Effect<SessionHeader, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const entries = yield* opened.session.entries
		const model = activeModelFromEntries(entries, opened.session.rootAgentId)
		const credential = yield* credentialSummary(model, options)
		const agentMode = agentModeLabel(options)

		const header: Mutable<SessionHeader> = {
			sessionId: opened.session.sessionId,
			cwd: options.cwd,
			logPath: opened.logPath,
			mode: opened.mode,
			resumeFlags: resumeFlagsFor(options),
			model,
			credential,
		}
		if (agentMode !== undefined) header.agentMode = agentMode
		if (options.profile !== undefined) header.profile = options.profile
		return header
	})

const renderLiveEvents = (
	session: FoldSession<
		| FileSystem.FileSystem
		| Path.Path
		| ChildProcessSpawner.ChildProcessSpawner
		| OutputStore
		| Photon
		| HttpClient.HttpClient
	>,
	renderer: OutputRenderer,
): Effect.Effect<Fiber.Fiber<void>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const entries = yield* session.entries
		const fromSeq = Arr.match(entries, {
			onEmpty: () => 0,
			onNonEmpty: (nonEmpty) => Arr.lastNonEmpty(nonEmpty).seq + 1,
		})
		const render = session.events(fromSeq).pipe(Stream.runForEach(renderer.renderEvent), Effect.ignoreCause)
		const fiber = yield* Effect.forkScoped(render, { startImmediately: true })
		yield* Effect.yieldNow
		return fiber
	})

const withProcessSignals = <A, E, R>(
	session: FoldSession<
		| FileSystem.FileSystem
		| Path.Path
		| ChildProcessSpawner.ChildProcessSpawner
		| OutputStore
		| Photon
		| HttpClient.HttpClient
	>,
	renderer: OutputRenderer,
	effect: Effect.Effect<A, E, R>,
	onSignal: Effect.Effect<void> = session.interrupt(),
): Effect.Effect<A, E, R> =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			let fired = false
			const handler = (): void => {
				if (fired) return
				fired = true
				Effect.runFork(
					renderer.renderNote('interrupt requested; saving session state').pipe(Effect.andThen(onSignal)),
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
 * layout: `~/.fold` with a starter `config.jsonc` (when absent), an empty 0600 `auth.json` (when
 * absent), and the regenerated `config.schema.json` + `FOLD_INFO.md`. Never fails a run - a broken
 * home surfaces as the launch's own config error moments later.
 */
const bootstrapForRun = (
	options: CliSessionOptions,
): Effect.Effect<void, never, FileSystem.FileSystem | HttpClient.HttpClient> => {
	const bootstrapOptions: Mutable<NonNullable<Parameters<typeof bootstrapFoldHome>[0]>> = {}
	if (options.foldHome !== undefined) bootstrapOptions.foldHome = options.foldHome
	// Debug level: a warning on the console would mix into prompt and JSON output, and the launch reports
	// a broken home through its own config error moments later.
	return bootstrapFoldHome(bootstrapOptions).pipe(
		Effect.asVoid,
		Effect.catchCause((cause) => Effect.logDebug('fold home bootstrap failed', cause)),
	)
}

const forkStartupEnsures = (
	options: CliSessionOptions,
	renderer: OutputRenderer,
): Effect.Effect<void, never, ManagedBinaries | Scope.Scope> =>
	Effect.forkScoped(
		Effect.gen(function* () {
			const statuses = yield* ensureManagedBinaries({
				foldHome: options.foldHome ?? defaultFoldHome(),
				requireManagedInstall: true,
			})
			yield* Effect.forEach(
				statuses.filter((status) => status.resolution === 'installed-now'),
				(status) => renderer.renderNote(`installed ${status.name} into ${status.path ?? 'the fold bin dir'}`),
			)
		}),
	).pipe(Effect.asVoid)

/**
 * After a headless prompt's own turn: wait until background agents have finished and every
 * notification turn they triggered has run, then return the root's latest outcome. Agents still
 * running after `timeout` are stopped (recorded `stopped`; no further turn). An interrupted prompt
 * stops background agents at once instead of waiting.
 */
export const settleBackgroundWork = <R>(
	session: FoldSession<R>,
	renderer: Pick<OutputRenderer, 'renderNote'>,
	sent: AgentFinishedLogEntry,
	timeout: Duration.Input = DEFAULT_BACKGROUND_TIMEOUT,
): Effect.Effect<AgentFinishedLogEntry> =>
	Effect.gen(function* () {
		if (sent.outcome === 'interrupted') {
			yield* session.stop('the user interrupted the run')
			return sent
		}

		const running = (yield* session.backgroundTasks).filter((task) => task.status === 'running').length
		if (running > 0) {
			yield* renderer.renderNote(`waiting for ${running} background agent${running === 1 ? '' : 's'} to finish`)
		}
		const settled = yield* session.awaitBackgroundIdle.pipe(Effect.timeoutOption(timeout))
		if (Option.isNone(settled)) {
			yield* renderer.renderNote(
				`background agents still running after ${Duration.format(Duration.fromInputUnsafe(timeout))}; stopping them`,
			)
			yield* session.stop('background agents did not finish before the run timed out')
			yield* session.awaitBackgroundIdle
		}

		const entries = yield* session.entries
		const latest = entries.findLast(
			(entry): entry is AgentFinishedLogEntry =>
				Predicate.isTagged(entry, 'agent-finished') && entry.agentId === session.rootAgentId,
		)
		return latest ?? sent
	})

/** Open a session, print its header, and run one CI-friendly prompt. */
export const runPrompt = (
	options: PromptRunOptions,
	renderer: OutputRenderer,
): Effect.Effect<
	AgentFinishedLogEntry,
	OpenSessionError,
	| Scope.Scope
	| Ids
	| FileSystem.FileSystem
	| Path.Path
	| ChildProcessSpawner.ChildProcessSpawner
	| Photon
	| HttpClient.HttpClient
	| ManagedBinaries
> =>
	Effect.gen(function* () {
		yield* bootstrapForRun(options)
		const opened = yield* openSession(options)
		yield* renderer.renderHeader(yield* sessionHeader(opened, options))
		const renderFiber = yield* renderLiveEvents(opened.session, renderer)
		yield* forkStartupEnsures(options, renderer)
		const sent = yield* withProcessSignals(
			opened.session,
			renderer,
			opened.session.send(options.prompt).pipe(
				Effect.orDie,
				Effect.onExit((exit) =>
					Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) ? opened.session.interrupt() : Effect.void,
				),
			),
		)
		// Background agents keep the run open: their notification turns are part of this prompt's answer.
		// A signal while waiting stops them (an interrupt alone would leave them running).
		const finished = yield* withProcessSignals(
			opened.session,
			renderer,
			settleBackgroundWork(opened.session, renderer, sent, options.backgroundTimeout),
			opened.session.stop('the user interrupted the run'),
		)
		yield* Effect.yieldNow
		yield* renderer.renderFinish(finished)
		yield* Fiber.interrupt(renderFiber)
		return finished
	})
