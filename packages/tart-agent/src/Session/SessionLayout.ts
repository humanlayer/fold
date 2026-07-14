/**
 * This file implements the D5 session layout and discovery: one JSONL log per session under
 * `~/.tart/sessions/<project-slug>/<sess_id>.jsonl`, where the slug is the escaped working directory
 * (pi-style), so "resume the latest session in this project" is a directory listing. `prepareSessionLog`
 * mints the session id UP FRONT (the file is named by it - `startSession({ sessionId })` records the
 * same id durably) and returns the ready log descriptor; `listSessionLogs`/`latestSessionLog` discover
 * existing logs newest-first for the resume-latest path, while `sessionLogById` resolves an exact
 * `sess_*` id inside the current project's slug directory.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { SessionId, usageInputTotal } from '@humanlayer/tart-core'
import type { ActiveModel, LogEntry, TartEventLog } from '@humanlayer/tart-core'
import { Effect, Exit, Match, Option, Schema, Stream } from 'effect'

import { jsonlEventLog } from '../EventLog/JsonlDescriptor'
import { fileSystemFor, type FsToolOptions } from '../Fs/DefaultFileSystem'
import { toolOutputSessionDirFor } from '../OutputStore/OutputStore'

/** Options shared by the layout helpers. */
export type SessionLayoutOptions = {
	/** The project working directory the sessions belong to. Defaults to `process.cwd()`. */
	readonly cwd?: string
	/** The tart home directory. Defaults to `~/.tart`. */
	readonly tartHome?: string
	/** Filesystem override for discovery (tests); defaults to the Node platform filesystem. */
	readonly fileSystem?: FsToolOptions['fileSystem']
}

/** One discovered session log. */
export type SessionLogRef = {
	readonly sessionId: SessionId
	readonly path: string
	/** Last-modified time of the log file, for newest-first ordering. */
	readonly mtimeMs: number
	readonly size?: number
}

/** Lightweight metadata used by session pickers without resuming the agent runtime. */
export type SessionSummary = SessionLogRef & {
	readonly title: string
	readonly status: 'ready' | 'running' | 'stopped' | 'error'
	readonly turns: number
	readonly providerId: string | null
	readonly modelId: string | null
	readonly model: ActiveModel | null
	readonly contextTokens: number | null
	readonly mode: string | null
	readonly rpi: boolean
	readonly profile: string | null
}

const decodeSessionId = Schema.decodeUnknownOption(SessionId)

/**
 * The project slug for one working directory (pi-style escaped cwd): every non-alphanumeric run
 * becomes a single dash, so `/Users/kyle/projects/tart` -> `Users-kyle-projects-tart`. Deterministic,
 * filesystem-safe, and readable in a directory listing.
 */
export const projectSlugFor = (cwd: string): string => {
	const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
	return slug.length === 0 ? 'root' : slug
}

/** The sessions directory for one project: `<tartHome>/sessions/<project-slug>`. */
export const sessionsDirFor = (options?: SessionLayoutOptions): string =>
	join(options?.tartHome ?? join(homedir(), '.tart'), 'sessions', projectSlugFor(options?.cwd ?? process.cwd()))

/** The log path for one session id under the project's sessions directory. */
export const sessionLogPathFor = (sessionId: SessionId, options?: SessionLayoutOptions): string =>
	join(sessionsDirFor(options), `${sessionId}.jsonl`)

/** Schema for a deleted session record in the index. */
const DeletedIndexRecord = Schema.TaggedStruct('deleted', {
	sessionId: SessionId,
	ts: Schema.Number,
})

/** Schema for the session summary as persisted in the index. */
const SessionSummarySchema = Schema.Struct({
	sessionId: SessionId,
	path: Schema.String,
	mtimeMs: Schema.Number,
	size: Schema.optional(Schema.Number),
	title: Schema.String,
	status: Schema.Literals(['ready', 'running', 'stopped', 'error']),
	turns: Schema.Number,
	providerId: Schema.NullOr(Schema.String),
	modelId: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.Any),
	contextTokens: Schema.NullOr(Schema.Number),
	mode: Schema.NullOr(Schema.String),
	rpi: Schema.Boolean,
	profile: Schema.NullOr(Schema.String),
})

/** Schema for a summary record in the index (includes source file metadata for cache validation). */
const SummaryIndexRecord = Schema.TaggedStruct('summary', {
	sourceMtimeMs: Schema.Number,
	sourceSize: Schema.Number,
	summary: SessionSummarySchema,
})

const SessionIndexRecordSchema = Schema.Union([SummaryIndexRecord, DeletedIndexRecord])
type SessionIndexRecord = typeof SessionIndexRecordSchema.Type

const decodeIndexRecord = Schema.decodeUnknownOption(SessionIndexRecordSchema)

const appendSessionIndexRecord = (record: SessionIndexRecord, options?: SessionLayoutOptions): Effect.Effect<void> => {
	const fs = fileSystemFor(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
	const directory = sessionsDirFor(options)
	return fs.makeDirectory(directory, { recursive: true }).pipe(
		Effect.andThen(
			fs.writeFileString(join(directory, 'index.jsonl'), `${JSON.stringify(record)}\n`, { flag: 'a' }),
		),
		Effect.catch(() => Effect.void),
	)
}

const sessionIdFromIndexRecord = Match.type<SessionIndexRecord>().pipe(
	Match.tag('summary', ({ summary }) => summary.sessionId),
	Match.tag('deleted', ({ sessionId }) => sessionId),
	Match.exhaustive,
)

const loadSessionIndex = (options?: SessionLayoutOptions): Effect.Effect<Map<SessionId, SessionIndexRecord>> => {
	const fs = fileSystemFor(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
	return fs.readFileString(join(sessionsDirFor(options), 'index.jsonl')).pipe(
		Effect.map((contents) => {
			const latest = new Map<SessionId, SessionIndexRecord>()
			for (const line of contents.split('\n')) {
				if (line.trim().length === 0) continue
				try {
					const record = decodeIndexRecord(JSON.parse(line))
					if (Option.isSome(record)) latest.set(sessionIdFromIndexRecord(record.value), record.value)
				} catch {
					// A partial/corrupt cache row is independently recoverable from the source log.
				}
			}
			return latest
		}),
		Effect.catch(() => Effect.succeed(new Map<SessionId, SessionIndexRecord>())),
	)
}

/**
 * Mint a session id and prepare its log location: the directory exists, the path is derived from the
 * id, and the returned descriptor plugs straight into `startSession({ sessionId, log })` - so the
 * durable `session_started.sessionId` and the filename agree (D5).
 */
export const prepareSessionLog = (
	options?: SessionLayoutOptions,
): Effect.Effect<{ readonly sessionId: SessionId; readonly path: string; readonly log: TartEventLog }> =>
	Effect.gen(function* () {
		const fs = fileSystemFor(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
		const sessionId = SessionId.create()
		const directory = sessionsDirFor(options)
		yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie)

		const path = sessionLogPathFor(sessionId, options)
		return { sessionId, path, log: jsonlEventLog(path) }
	})

/** Discover this project's session logs, newest first (by file mtime). */
export const listSessionLogs = (options?: SessionLayoutOptions): Effect.Effect<ReadonlyArray<SessionLogRef>> =>
	Effect.gen(function* () {
		const fs = fileSystemFor(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
		const directory = sessionsDirFor(options)

		const names = yield* fs
			.readDirectory(directory)
			.pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])))

		const refs: Array<SessionLogRef> = []
		for (const name of names) {
			if (!name.endsWith('.jsonl')) continue
			const decoded = decodeSessionId(name.slice(0, -'.jsonl'.length))
			if (Option.isNone(decoded)) continue

			const path = join(directory, name)
			const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.succeed(null)))
			if (info === null || info.type !== 'File') continue

			refs.push({
				sessionId: decoded.value,
				path,
				mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (mtime) => mtime.getTime() }),
				size: Number(info.size),
			})
		}

		return refs.sort((left, right) => right.mtimeMs - left.mtimeMs)
	})

// Type-safe entry predicates that narrow the LogEntry union.
const isSessionStarted = (entry: LogEntry): entry is Extract<LogEntry, { readonly _tag: 'session_started' }> =>
	entry._tag === 'session_started'

const isSessionTitle = (entry: LogEntry): entry is Extract<LogEntry, { readonly _tag: 'session_title' }> =>
	entry._tag === 'session_title'

const isUserMessage = (entry: LogEntry): entry is Extract<LogEntry, { readonly _tag: 'user-message' }> =>
	entry._tag === 'user-message'

const isAgentFinished = (entry: LogEntry): entry is Extract<LogEntry, { readonly _tag: 'agent-finished' }> =>
	entry._tag === 'agent-finished'

type ModelCarrier = Extract<LogEntry, { readonly _tag: 'agent_started' | 'model-change' }>
const carriesModel = (entry: LogEntry): entry is ModelCarrier =>
	entry._tag === 'agent_started' || entry._tag === 'model-change'

type FinishedAssistantMessage = Extract<LogEntry, { readonly _tag: 'assistant-message' }> & {
	readonly finish: NonNullable<Extract<LogEntry, { readonly _tag: 'assistant-message' }>['finish']>
}
const isFinishedAssistantMessage = (entry: LogEntry): entry is FinishedAssistantMessage =>
	entry._tag === 'assistant-message' && entry.finish !== null

const userMessageText = (entry: Extract<LogEntry, { readonly _tag: 'user-message' }>): string => {
	const content = entry.message.content
	return typeof content === 'string'
		? content
		: content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

const computeStatus = (
	lastFinished: Extract<LogEntry, { readonly _tag: 'agent-finished' }> | undefined,
	latestRootEntry: LogEntry | undefined,
): SessionSummary['status'] => {
	// No finish yet, or activity after the last finish → derive from latest activity
	if (lastFinished === undefined || (latestRootEntry !== undefined && latestRootEntry.seq > lastFinished.seq)) {
		return latestRootEntry?._tag === 'system-message' || latestRootEntry?._tag === 'agent_started'
			? 'ready'
			: 'running'
	}
	// Finished → map outcome to status
	return Match.value(lastFinished.outcome).pipe(
		Match.when('completed', () => 'ready' as const),
		Match.when('error', () => 'error' as const),
		Match.orElse(() => 'stopped' as const),
	)
}

const sessionSummary = (ref: SessionLogRef, entries: ReadonlyArray<LogEntry>): SessionSummary => {
	const started = entries.find(isSessionStarted)
	const rootAgentId = started?.rootAgentId ?? null
	const rootEntries = entries.filter(
		(entry) =>
			isSessionStarted(entry) ||
			isSessionTitle(entry) ||
			(rootAgentId === null ? entry.parentAgentId === null : entry.agentId === rootAgentId),
	)
	const userEntries = rootEntries.filter(isUserMessage)
	const generatedTitle = rootEntries.findLast(isSessionTitle)
	const title =
		generatedTitle !== undefined
			? generatedTitle.title
			: userEntries[0] === undefined
				? 'Untitled session'
				: userMessageText(userEntries[0]).replace(/\s+/g, ' ').trim()
	const modelEntry = rootEntries.findLast(carriesModel)
	const model = modelEntry?.model ?? null
	const latestUsage = rootEntries.findLast(isFinishedAssistantMessage)
	const meta = started?.meta ?? {}
	const lastFinished = rootEntries.findLast(isAgentFinished)
	const latestRootEntry = rootEntries.findLast((entry) => !isSessionTitle(entry))
	const status = computeStatus(lastFinished, latestRootEntry)

	return {
		...ref,
		title: title.length === 0 ? 'Untitled session' : title,
		status,
		turns: userEntries.length,
		providerId: model?.providerId ?? null,
		modelId: model?.modelId ?? null,
		model,
		contextTokens: latestUsage !== undefined ? usageInputTotal(latestUsage.finish.usage) : null,
		mode: typeof meta.mode === 'string' ? meta.mode : null,
		rpi: meta.rpi === true,
		profile: typeof meta.profile === 'string' ? meta.profile : null,
	}
}

const loadSessionSummary = (ref: SessionLogRef): Effect.Effect<SessionSummary | null> =>
	Match.value(jsonlEventLog(ref.path)).pipe(
		Match.tag('source', (descriptor) =>
			Effect.exit(
				Effect.scoped(
					descriptor.make.pipe(
						Effect.flatMap((eventLog) => Stream.runCollect(eventLog.entries())),
						Effect.map((entries) => sessionSummary(ref, Array.from(entries))),
					),
				),
			).pipe(Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : null))),
		),
		Match.orElse(() => Effect.succeed(null)),
	)

/** Check if a cached record is still valid for the given session log ref. */
const isCacheHit = (
	cached: SessionIndexRecord | undefined,
	ref: SessionLogRef,
): cached is typeof SummaryIndexRecord.Type =>
	cached !== undefined &&
	cached._tag === 'summary' &&
	cached.sourceMtimeMs === ref.mtimeMs &&
	cached.sourceSize === (ref.size ?? 0)

/** Read the one-file picker cache, rebuilding only stale/missing records from authoritative logs. */
export const listSessionSummaries = (options?: SessionLayoutOptions): Effect.Effect<ReadonlyArray<SessionSummary>> =>
	Effect.gen(function* () {
		const refs = yield* listSessionLogs(options)
		const index = yield* loadSessionIndex(options)
		const summaries = yield* Effect.forEach(
			refs,
			(ref): Effect.Effect<SessionSummary | null> => {
				const cached = index.get(ref.sessionId)
				if (isCacheHit(cached, ref)) {
					// Explicitly construct to ensure size conforms to SessionLogRef's optional semantics.
					const summary = cached.summary
					return Effect.succeed({
						sessionId: summary.sessionId,
						path: ref.path,
						mtimeMs: ref.mtimeMs,
						...(ref.size === undefined ? {} : { size: ref.size }),
						title: summary.title,
						status: summary.status,
						turns: summary.turns,
						providerId: summary.providerId,
						modelId: summary.modelId,
						model: summary.model,
						contextTokens: summary.contextTokens,
						mode: summary.mode,
						rpi: summary.rpi,
						profile: summary.profile,
					})
				}
				return loadSessionSummary(ref).pipe(
					Effect.tap((summary) =>
						summary === null
							? Effect.void
							: appendSessionIndexRecord(
									{ _tag: 'summary', sourceMtimeMs: ref.mtimeMs, sourceSize: ref.size ?? 0, summary },
									options,
								),
					),
				)
			},
			{ concurrency: 8 },
		)
		return summaries.filter((summary): summary is SessionSummary => summary !== null)
	})

export type DeleteSessionResult = {
	readonly deleted: boolean
	readonly outputRemoved: boolean
}

/** Delete one project's session log and all full tool-output files owned by that session. */
export const deleteSession = (
	sessionId: SessionId,
	options?: SessionLayoutOptions,
): Effect.Effect<DeleteSessionResult> =>
	Effect.gen(function* () {
		const fs = fileSystemFor(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
		const logPath = sessionLogPathFor(sessionId, options)
		const exists = yield* fs.exists(logPath).pipe(Effect.orDie)
		if (!exists) return { deleted: false, outputRemoved: true }

		const tartHome = options?.tartHome ?? join(homedir(), '.tart')
		const outputDirectory = toolOutputSessionDirFor({ sessionId, tartHome })
		const outputExists = yield* fs.exists(outputDirectory).pipe(Effect.orDie)
		yield* fs.remove(logPath).pipe(Effect.orDie)
		yield* appendSessionIndexRecord({ _tag: 'deleted', sessionId, ts: Date.now() }, options)
		if (!outputExists) return { deleted: true, outputRemoved: true }

		const outputRemoval = yield* Effect.exit(fs.remove(outputDirectory, { recursive: true }))
		return { deleted: true, outputRemoved: Exit.isSuccess(outputRemoval) }
	})

/** The newest session log for this project, or null when none exist ("resume latest" - D5). */
export const latestSessionLog = (options?: SessionLayoutOptions): Effect.Effect<SessionLogRef | null> =>
	listSessionLogs(options).pipe(Effect.map((refs) => refs[0] ?? null))

/** Resolve an exact session id under this project's session directory, or null when it is absent. */
export const sessionLogById = (
	sessionId: SessionId,
	options?: SessionLayoutOptions,
): Effect.Effect<SessionLogRef | null> =>
	Effect.gen(function* () {
		const fs = fileSystemFor(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
		const path = sessionLogPathFor(sessionId, options)
		const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.succeed(null)))

		if (info === null || info.type !== 'File') return null

		return {
			sessionId,
			path,
			mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (mtime) => mtime.getTime() }),
			size: Number(info.size),
		}
	})

/** Rebuild and append one authoritative summary after session metadata changes. */
export const refreshSessionSummaryIndex = (sessionId: SessionId, options?: SessionLayoutOptions): Effect.Effect<void> =>
	sessionLogById(sessionId, options).pipe(
		Effect.flatMap((ref) => {
			if (ref === null) return Effect.void
			return loadSessionSummary(ref).pipe(
				Effect.flatMap((summary) =>
					summary === null
						? Effect.void
						: appendSessionIndexRecord(
								{
									_tag: 'summary',
									sourceMtimeMs: ref.mtimeMs,
									sourceSize: ref.size ?? 0,
									summary,
								},
								options,
							),
				),
			)
		}),
	)
