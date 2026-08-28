import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { Effect, type FileSystem, Schema } from 'effect'

import { fileSystemFor } from '../Fs/DefaultFileSystem'

export const CodexInstructionSource = Schema.Struct({
	path: Schema.String,
	content: Schema.String,
	scope: Schema.Literals(['global', 'ancestor']),
})
export type CodexInstructionSource = typeof CodexInstructionSource.Type

export type CodexInstructionOptions = {
	readonly cwd: string
	readonly home?: string
	readonly codexHome?: string
	readonly fileSystem?: FileSystem.FileSystem
}

const readNonEmpty = (fs: FileSystem.FileSystem, path: string): Effect.Effect<CodexInstructionSource | null> =>
	fs.readFileString(path).pipe(
		Effect.map((content) => (content.trim().length === 0 ? null : { path, content, scope: 'ancestor' as const })),
		Effect.catch(() => Effect.succeed(null)),
	)

const isAncestor = (ancestor: string, path: string): boolean => {
	let current = path
	while (true) {
		if (current === ancestor) return true
		const parent = dirname(current)
		if (parent === current) return false
		current = parent
	}
}

const directoriesToBoundary = (cwd: string, home: string | null): ReadonlyArray<string> => {
	const directories: Array<string> = []
	const boundary = home !== null && isAncestor(home, cwd) ? home : null
	let current = cwd
	while (true) {
		directories.push(current)
		if (current === boundary) break
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	return directories.reverse()
}

export const loadCodexInstructions = (
	options: CodexInstructionOptions,
): Effect.Effect<ReadonlyArray<CodexInstructionSource>> =>
	Effect.gen(function* () {
		const fs = fileSystemFor(options)
		const cwd = resolve(options.cwd)
		const home = options.home === undefined ? homedir() : options.home
		const resolvedHome = home.length === 0 ? null : resolve(home)
		const codexHome = resolve(options.codexHome ?? join(resolvedHome ?? homedir(), '.codex'))
		const sources: Array<CodexInstructionSource> = []

		for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
			const source = yield* readNonEmpty(fs, join(codexHome, name))
			if (source !== null) {
				sources.push({ ...source, scope: 'global' })
				break
			}
		}

		for (const directory of directoriesToBoundary(cwd, resolvedHome)) {
			const override = yield* readNonEmpty(fs, join(directory, 'AGENTS.override.md'))
			if (override !== null) {
				sources.push(override)
				continue
			}

			const base = yield* readNonEmpty(fs, join(directory, 'AGENTS.md'))
			if (base !== null) sources.push(base)
			const local = yield* readNonEmpty(fs, join(directory, 'AGENTS.local.md'))
			if (local !== null) sources.push(local)
		}

		return sources
	})

const escapeXmlAttribute = (text: string): string =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')

export const renderCodexInstructions = (sources: ReadonlyArray<CodexInstructionSource>): string | null => {
	if (sources.length === 0) return null
	return `<project_context>\n${sources
		.map(
			(source) =>
				`<project_instructions path="${escapeXmlAttribute(source.path)}">\n${source.content.trim()}\n</project_instructions>`,
		)
		.join('\n')}\n</project_context>`
}
