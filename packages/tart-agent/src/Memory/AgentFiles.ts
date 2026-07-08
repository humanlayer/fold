/**
 * This file loads agentfiles / memory files (D22): `AGENTS.md` and `CLAUDE.md` (with `.local.md`
 * overlays), discovered pi-style and folded into the leading system prompt. Discovery is:
 *
 *   1. Global chain, first existing wins: `~/.tart/AGENTS.md` -> `~/.agents/AGENTS.md` ->
 *      `~/.codex/AGENTS.md` (family-agnostic; no global CLAUDE.md, no global `.local` overlay).
 *   2. Project walk: cwd up to the filesystem root, collecting every directory, rendered
 *      global -> root -> ... -> cwd (nearest-to-cwd LAST, so later supersedes earlier). Per directory:
 *      the base file is the first existing of [AGENTS.md, CLAUDE.md], and a local overlay - the first
 *      existing of [AGENTS.local.md, CLAUDE.local.md] - renders immediately after it (loaded even when
 *      the base is absent; intended as a gitignored personal overlay).
 *
 * Files are deduped by path. The whole set is baked once per model epoch (the launch/resume caller
 * folds `memoryPromptBlock` into the agent's leading blocks) - never re-read per request (prefix
 * stability). Rendering is pi's shape: one `<project_context>` wrapping one `<project_instructions
 * path="...">` per file.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { Effect, type FileSystem, Schema } from 'effect'

import { fileSystemFor, type FsToolOptions } from '../Fs/DefaultFileSystem'

/** One loaded agentfile. */
export const MemoryFile = Schema.Struct({
	/** Absolute path the file was read from (rendered in the instruction block for provenance). */
	path: Schema.String,
	content: Schema.String,
}).annotate({ identifier: 'MemoryFile' })
export type MemoryFile = typeof MemoryFile.Type

/** Options for the agentfile loaders. */
export type AgentFilesOptions = {
	/** Project directory the walk starts from. Defaults to `process.cwd()`. */
	readonly cwd?: string
	/** Home directory for the global chain. Defaults to `os.homedir()`. */
	readonly home?: string
	/** FileSystem override for hermetic tests. Defaults to the Node platform filesystem. */
	readonly fileSystem?: FsToolOptions['fileSystem']
}

/** Per-directory base filenames, in preference order (first existing wins). */
const BASE_CANDIDATES: ReadonlyArray<string> = ['AGENTS.md', 'CLAUDE.md']

/** Per-directory local overlay filenames, in preference order (first existing wins). */
const LOCAL_CANDIDATES: ReadonlyArray<string> = ['AGENTS.local.md', 'CLAUDE.local.md']

/** The global chain: family-agnostic AGENTS.md, first existing wins. */
const globalChain = (home: string): ReadonlyArray<string> => [
	join(home, '.tart', 'AGENTS.md'),
	join(home, '.agents', 'AGENTS.md'),
	join(home, '.codex', 'AGENTS.md'),
]

/** Directories from `start` up to the filesystem root, nearest first. */
const ancestorDirectories = (start: string): ReadonlyArray<string> => {
	const dirs: Array<string> = []
	let current = start
	while (true) {
		dirs.push(current)
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	return dirs
}

const fileExists = (fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean> =>
	fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)))

/**
 * Load agentfiles for a working directory in render order (global, then root..cwd; base then local
 * overlay within each directory). Deduped by path.
 */
export const loadMemoryFiles = (options?: AgentFilesOptions): Effect.Effect<ReadonlyArray<MemoryFile>> =>
	Effect.gen(function* () {
		const fs = fileSystemFor(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
		const cwd = options?.cwd ?? process.cwd()
		const home = options?.home ?? homedir()

		const collected: Array<MemoryFile> = []
		const seen = new Set<string>()

		const addFile = (path: string): Effect.Effect<void> =>
			Effect.gen(function* () {
				if (seen.has(path)) return
				const content = yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed(null)))
				if (content === null) return
				seen.add(path)
				collected.push({ path, content })
			})

		/** Add the first existing candidate (per-directory base/overlay preference). */
		const addFirstExisting = (candidates: ReadonlyArray<string>): Effect.Effect<void> =>
			Effect.gen(function* () {
				for (const path of candidates) {
					if (yield* fileExists(fs, path)) {
						yield* addFile(path)
						return
					}
				}
			})

		// 1. Global chain (first existing wins).
		yield* addFirstExisting(globalChain(home))

		// 2. Project walk, ordered root -> cwd so the nearest directory renders last.
		const directories = [...ancestorDirectories(cwd)].reverse()
		for (const directory of directories) {
			yield* addFirstExisting(BASE_CANDIDATES.map((name) => join(directory, name)))
			yield* addFirstExisting(LOCAL_CANDIDATES.map((name) => join(directory, name)))
		}

		return collected
	})

/** Escape a value destined for an XML attribute. */
const escapeXmlAttribute = (text: string): string =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')

/** Render loaded agentfiles as one `<project_context>` prompt block (pi shape). Null when empty. */
export const renderMemoryFiles = (files: ReadonlyArray<MemoryFile>): string | null => {
	if (files.length === 0) return null

	const blocks = files.map(
		(file) =>
			`<project_instructions path="${escapeXmlAttribute(file.path)}">\n${file.content.trim()}\n</project_instructions>`,
	)
	return `<project_context>\n${blocks.join('\n')}\n</project_context>`
}

/** Load and render the agentfiles for a working directory as one leading prompt block (null when none). */
export const memoryPromptBlock = (options?: AgentFilesOptions): Effect.Effect<string | null> =>
	loadMemoryFiles(options).pipe(Effect.map(renderMemoryFiles))
