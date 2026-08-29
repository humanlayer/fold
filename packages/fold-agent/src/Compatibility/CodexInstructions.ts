import { homedir } from 'node:os'

import { Effect, FileSystem, Path, Schema } from 'effect'

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
}

const readNonEmpty = (path: string): Effect.Effect<CodexInstructionSource | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.readFileString(path).pipe(
			Effect.map((content) =>
				content.trim().length === 0 ? null : { path, content, scope: 'ancestor' as const },
			),
			Effect.catch(() => Effect.succeed(null)),
		)
	})

const isAncestor = (ancestor: string, candidate: string): Effect.Effect<boolean, never, Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		let current = candidate
		while (true) {
			if (current === ancestor) return true
			const parent = path.dirname(current)
			if (parent === current) return false
			current = parent
		}
	})

const directoriesToBoundary = (
	cwd: string,
	home: string | null,
): Effect.Effect<ReadonlyArray<string>, never, Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const directories: Array<string> = []
		const boundary = home !== null && (yield* isAncestor(home, cwd)) ? home : null
		let current = cwd
		while (true) {
			directories.push(current)
			if (current === boundary) break
			const parent = path.dirname(current)
			if (parent === current) break
			current = parent
		}
		return directories.reverse()
	})

export const loadCodexInstructions = (
	options: CodexInstructionOptions,
): Effect.Effect<ReadonlyArray<CodexInstructionSource>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const cwd = path.resolve(options.cwd)
		const home = options.home === undefined ? homedir() : options.home
		const resolvedHome = home.length === 0 ? null : path.resolve(home)
		const codexHome = path.resolve(options.codexHome ?? path.join(resolvedHome ?? homedir(), '.codex'))
		const sources: Array<CodexInstructionSource> = []

		for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
			const source = yield* readNonEmpty(path.join(codexHome, name))
			if (source !== null) {
				sources.push({ ...source, scope: 'global' })
				break
			}
		}

		for (const directory of yield* directoriesToBoundary(cwd, resolvedHome)) {
			const override = yield* readNonEmpty(path.join(directory, 'AGENTS.override.md'))
			if (override !== null) {
				sources.push(override)
				continue
			}

			const base = yield* readNonEmpty(path.join(directory, 'AGENTS.md'))
			if (base !== null) sources.push(base)
			const local = yield* readNonEmpty(path.join(directory, 'AGENTS.local.md'))
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
