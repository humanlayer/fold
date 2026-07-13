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
import { Effect, Exit, Option, Schema, Stream } from 'effect'

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

type SessionIndexRecord =
	| {
			readonly _tag: 'summary'
			readonly sourceMtimeMs: number
			readonly sourceSize: number
			readonly summary: SessionSummary
	  }
	| { readonly _tag: 'deleted'; readonly sessionId: SessionId; readonly ts: number }

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

const sessionIdFromIndexRecord = (record: SessionIndexRecord): SessionId =>
	record._tag === 'summary' ? record.summary.sessionId : record.sessionId

const decodeIndexRecord = (value: unknown): SessionIndexRecord | null => {
	if (typeof value !== 'object' || value === null || !('_tag' in value)) return null
	if (value._tag === 'deleted' && 'sessionId' in value && 'ts' in value) {
		const sessionId = decodeSessionId(value.sessionId)
		return Option.isSome(sessionId) && typeof value.ts === 'number'
			? { _tag: 'deleted', sessionId: sessionId.value, ts: value.ts }
			: null
	}
	if (value._tag !== 'summary' || !('sourceMtimeMs' in value) || !('sourceSize' in value) || !('summary' in value))
		return null
	const summary = value.summary
	if (
		typeof value.sourceMtimeMs !== 'number' ||
		typeof value.sourceSize !== 'number' ||
		typeof summary !== 'object' ||
		summary === null
	)
		return null
	if (!('sessionId' in summary) || !('title' in summary) || !('path' in summary) || !('mtimeMs' in summary))
		return null
	const sessionId = decodeSessionId(summary.sessionId)
	if (Option.isNone(sessionId) || typeof summary.title !== 'string' || typeof summary.path !== 'string') return null
	if (typeof summary.mtimeMs !== 'number' || !('status' in summary) || !('turns' in summary)) return null
	return {
		_tag: 'summary',
		sourceMtimeMs: value.sourceMtimeMs,
		sourceSize: value.sourceSize,
		summary: summary as SessionSummary,
	}
}

const loadSessionIndex = (options?: SessionLayoutOptions): Effect.Effect<Map<SessionId, SessionIndexRecord>> => {
	const fs = fileSystemFor(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
	return fs.readFileString(join(sessionsDirFor(options), 'index.jsonl')).pipe(
		Effect.map((contents) => {
			const latest = new Map<SessionId, SessionIndexRecord>()
			for (const line of contents.split('\n')) {
				if (line.trim().length === 0) continue
				try {
					const record = decodeIndexRecord(JSON.parse(line))
					if (record !== null) latest.set(sessionIdFromIndexRecord(record), record)
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

const userMessageText = (entry: Extract<LogEntry, { readonly _tag: 'user-message' }>): string => {
	const content = entry.message.content
	return typeof content === 'string'
		? content
		: content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

const sessionSummary = (ref: SessionLogRef, entries: ReadonlyArray<LogEntry>): SessionSummary => {
	const started = entries.find((entry) => entry._tag === 'session_started')
	const rootAgentId = started?._tag === 'session_started' ? started.rootAgentId : null
	const rootEntries = entries.filter(
		(entry) =>
			entry._tag === 'session_started' ||
			entry._tag === 'session_title' ||
			(rootAgentId === null ? entry.parentAgentId === null : entry.agentId === rootAgentId),
	)
	const userEntries = rootEntries.filter((entry) => entry._tag === 'user-message')
	const generatedTitle = rootEntries.findLast((entry) => entry._tag === 'session_title')
	const title =
		generatedTitle?._tag === 'session_title'
			? generatedTitle.title
			: userEntries[0] === undefined
				? 'Untitled session'
				: userMessageText(userEntries[0]).replace(/\s+/g, ' ').trim()
	const modelEntry = rootEntries.findLast((entry) => entry._tag === 'agent_started' || entry._tag === 'model-change')
	const model = modelEntry?._tag === 'agent_started' || modelEntry?._tag === 'model-change' ? modelEntry.model : null
	const latestUsage = rootEntries.findLast((entry) => entry._tag === 'assistant-message' && entry.finish !== null)
	const meta = started?._tag === 'session_started' ? started.meta : {}
	const lastFinished = rootEntries.findLast((entry) => entry._tag === 'agent-finished')
	const latestRootEntry = rootEntries.findLast((entry) => entry._tag !== 'session_title')
	const status: SessionSummary['status'] =
		lastFinished === undefined || (latestRootEntry !== undefined && latestRootEntry.seq > lastFinished.seq)
			? latestRootEntry?._tag === 'system-message' || latestRootEntry?._tag === 'agent_started'
				? 'ready'
				: 'running'
			: lastFinished.outcome === 'completed'
				? 'ready'
				: lastFinished.outcome === 'error'
					? 'error'
					: 'stopped'

	return {
		...ref,
		title: title.length === 0 ? 'Untitled session' : title,
		status,
		turns: userEntries.length,
		providerId: model?.providerId ?? null,
		modelId: model?.modelId ?? null,
		model,
		contextTokens:
			latestUsage?._tag === 'assistant-message' && latestUsage.finish !== null
				? usageInputTotal(latestUsage.finish.usage)
				: null,
		mode: typeof meta.mode === 'string' ? meta.mode : null,
		rpi: meta.rpi === true,
		profile: typeof meta.profile === 'string' ? meta.profile : null,
	}
}

const loadSessionSummary = (ref: SessionLogRef): Effect.Effect<SessionSummary | null> => {
	const descriptor = jsonlEventLog(ref.path)
	if (descriptor._tag !== 'source') return Effect.succeed(null)

	return Effect.exit(
		Effect.scoped(
			descriptor.make.pipe(
				Effect.flatMap((eventLog) => Stream.runCollect(eventLog.entries())),
				Effect.map((entries) => sessionSummary(ref, Array.from(entries))),
			),
		),
	).pipe(Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : null)))
}

/** Read the one-file picker cache, rebuilding only stale/missing records from authoritative logs. */
export const listSessionSummaries = (options?: SessionLayoutOptions): Effect.Effect<ReadonlyArray<SessionSummary>> =>
	Effect.gen(function* () {
		const refs = yield* listSessionLogs(options)
		const index = yield* loadSessionIndex(options)
		const summaries = yield* Effect.forEach(
			refs,
			(ref) => {
				const cached = index.get(ref.sessionId)
				if (
					cached?._tag === 'summary' &&
					cached.sourceMtimeMs === ref.mtimeMs &&
					cached.sourceSize === (ref.size ?? 0)
				) {
					return Effect.succeed({ ...cached.summary, path: ref.path, mtimeMs: ref.mtimeMs })
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
