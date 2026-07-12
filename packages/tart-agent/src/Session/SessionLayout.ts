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
}

/** Lightweight metadata used by session pickers without resuming the agent runtime. */
export type SessionSummary = SessionLogRef & {
	readonly title: string
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
	const rootEntries = entries.filter((entry) => entry.parentAgentId === null)
	const userEntries = rootEntries.filter((entry) => entry._tag === 'user-message')
	const title =
		userEntries[0] === undefined ? 'Untitled session' : userMessageText(userEntries[0]).replace(/\s+/g, ' ').trim()
	const modelEntry = rootEntries.findLast((entry) => entry._tag === 'agent_started' || entry._tag === 'model-change')
	const model = modelEntry?._tag === 'agent_started' || modelEntry?._tag === 'model-change' ? modelEntry.model : null
	const latestUsage = rootEntries.findLast((entry) => entry._tag === 'assistant-message' && entry.finish !== null)
	const started = rootEntries.find((entry) => entry._tag === 'session_started')
	const meta = started?._tag === 'session_started' ? started.meta : {}

	return {
		...ref,
		title: title.length === 0 ? 'Untitled session' : title,
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

/** Inspect valid logs for this project, newest first; corrupt logs are omitted independently. */
export const listSessionSummaries = (options?: SessionLayoutOptions): Effect.Effect<ReadonlyArray<SessionSummary>> =>
	listSessionLogs(options).pipe(
		Effect.flatMap((refs) => Effect.forEach(refs, loadSessionSummary, { concurrency: 8 })),
		Effect.map((summaries) => summaries.filter((summary): summary is SessionSummary => summary !== null)),
	)

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
		}
	})
