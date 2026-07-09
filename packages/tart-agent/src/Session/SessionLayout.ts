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

import { SessionId } from '@humanlayer/tart-core'
import type { TartEventLog } from '@humanlayer/tart-core'
import { Effect, Option, Schema } from 'effect'

import { jsonlEventLog } from '../EventLog/JsonlDescriptor'
import { fileSystemFor, type FsToolOptions } from '../Fs/DefaultFileSystem'

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
