import { homedir } from 'node:os'

import { Effect, FileSystem, Path, Schema } from 'effect'

export const GrokPluginDiagnostic = Schema.Struct({
	stage: Schema.Literals(['manifest', 'discovery']),
	code: Schema.String,
	path: Schema.String,
})
export type GrokPluginDiagnostic = typeof GrokPluginDiagnostic.Type

export type GrokPluginSkillRoot = { readonly name: string; readonly path: string }

export type GrokPluginOptions = {
	readonly cwd: string
	readonly home?: string
	readonly grokHome?: string
	readonly projectRoot?: string
	readonly configuredPaths?: ReadonlyArray<string>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

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

const ancestorDirectories = (
	cwd: string,
	boundary: string | null,
): Effect.Effect<ReadonlyArray<string>, never, Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const directories: Array<string> = []
		let current = cwd
		while (true) {
			directories.push(current)
			if (current === boundary) break
			const parent = path.dirname(current)
			if (parent === current) break
			current = parent
		}
		return directories
	})

const safeRelativePath = (value: unknown): string | null => {
	if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) return null
	const normalized = value.replace(/^\.\//, '')
	if (
		normalized.length === 0 ||
		normalized.startsWith('/') ||
		/^[A-Za-z]:\//.test(normalized) ||
		normalized.split('/').includes('..')
	)
		return null
	return normalized
}

const readManifest = (
	root: string,
): Effect.Effect<{ path: string; value: unknown } | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		for (const name of ['plugin.json', '.grok-plugin/plugin.json', '.claude-plugin/plugin.json']) {
			const manifestPath = path.join(root, name)
			const contents = yield* fs.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => null))
			if (contents === null) continue
			const value = yield* Effect.try(() => JSON.parse(contents)).pipe(Effect.orElseSucceed(() => null))
			return { path: manifestPath, value }
		}
		return null
	})

export const discoverGrokPluginSkillRoots = Effect.fn('fold.grok_compatibility.discover_plugin_skills')(function* (
	options: GrokPluginOptions,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const cwd = path.resolve(options.cwd)
	const homeValue = options.home === undefined ? homedir() : options.home
	const home = homeValue.length === 0 ? null : path.resolve(homeValue)
	const grokHome = path.resolve(options.grokHome ?? path.join(home ?? homedir(), '.grok'))
	const projectRoot = options.projectRoot === undefined ? null : path.resolve(options.projectRoot)
	const projectRootIsAncestor = projectRoot !== null && (yield* isAncestor(projectRoot, cwd))
	const homeIsAncestor = home !== null && (yield* isAncestor(home, cwd))
	const boundary = projectRootIsAncestor ? projectRoot : homeIsAncestor ? home : null
	const pluginParents = [
		...(options.configuredPaths ?? []).map((configuredPath) => path.resolve(configuredPath)),
		...(yield* ancestorDirectories(cwd, boundary)).flatMap((directory) => [
			path.join(directory, '.grok', 'plugins'),
			path.join(directory, '.claude', 'plugins'),
		]),
		path.join(grokHome, 'plugins'),
		...(home === null ? [] : [path.join(home, '.claude', 'plugins')]),
	]
	const diagnostics: Array<GrokPluginDiagnostic> = []
	const roots: Array<GrokPluginSkillRoot> = []
	const seenPaths = new Set<string>()
	const seenNames = new Set<string>()

	for (const parent of pluginParents) {
		const parentManifest = yield* readManifest(parent)
		const candidates =
			parentManifest === null
				? (yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => [])))
						.sort((left, right) => left.localeCompare(right))
						.map((entry) => path.join(parent, entry))
				: [parent]
		for (const candidate of candidates) {
			const normalized = path.resolve(candidate)
			if (seenPaths.has(normalized)) continue
			seenPaths.add(normalized)
			const manifest =
				candidate === parent && parentManifest !== null ? parentManifest : yield* readManifest(candidate)
			if (manifest !== null && !isRecord(manifest.value)) {
				diagnostics.push({ stage: 'manifest', code: 'manifest_parse_failed', path: manifest.path })
				continue
			}
			const manifestValue = manifest === null || !isRecord(manifest.value) ? null : manifest.value
			const name =
				manifestValue !== null && typeof manifestValue.name === 'string'
					? manifestValue.name
					: path.basename(candidate)
			if (name.length === 0 || seenNames.has(name)) continue
			const declared =
				manifestValue === null || manifestValue.skills === undefined
					? ['skills']
					: Array.isArray(manifestValue.skills)
						? manifestValue.skills
						: [manifestValue.skills]
			const skillRoots: Array<string> = []
			for (const value of declared) {
				const relativePath = safeRelativePath(value)
				if (relativePath === null) {
					diagnostics.push({
						stage: 'manifest',
						code: 'invalid_skill_root',
						path: manifest?.path ?? candidate,
					})
					continue
				}
				const skillRoot = path.resolve(candidate, relativePath)
				if (yield* fs.exists(skillRoot).pipe(Effect.orElseSucceed(() => false))) skillRoots.push(skillRoot)
			}
			if (skillRoots.length === 0) continue
			seenNames.add(name)
			for (const skillRoot of skillRoots) roots.push({ name, path: skillRoot })
		}
	}
	return { roots, diagnostics }
})
