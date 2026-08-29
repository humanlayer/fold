import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { Effect, FileSystem, Schema } from 'effect'

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

const isAncestor = (ancestor: string, path: string): boolean => {
	let current = path
	while (true) {
		if (current === ancestor) return true
		const parent = dirname(current)
		if (parent === current) return false
		current = parent
	}
}

const ancestorDirectories = (cwd: string, boundary: string | null): ReadonlyArray<string> => {
	const directories: Array<string> = []
	let current = cwd
	while (true) {
		directories.push(current)
		if (current === boundary) break
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	return directories
}

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
): Effect.Effect<{ path: string; value: unknown } | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		for (const name of ['plugin.json', '.grok-plugin/plugin.json', '.claude-plugin/plugin.json']) {
			const path = join(root, name)
			const contents = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => null))
			if (contents === null) continue
			const value = yield* Effect.try(() => JSON.parse(contents)).pipe(Effect.orElseSucceed(() => null))
			return { path, value }
		}
		return null
	})

export const discoverGrokPluginSkillRoots = Effect.fn('fold.grok_compatibility.discover_plugin_skills')(function* (
	options: GrokPluginOptions,
) {
	const fs = yield* FileSystem.FileSystem
	const cwd = resolve(options.cwd)
	const homeValue = options.home === undefined ? homedir() : options.home
	const home = homeValue.length === 0 ? null : resolve(homeValue)
	const grokHome = resolve(options.grokHome ?? join(home ?? homedir(), '.grok'))
	const projectRoot = options.projectRoot === undefined ? null : resolve(options.projectRoot)
	const boundary =
		projectRoot !== null && isAncestor(projectRoot, cwd)
			? projectRoot
			: home !== null && isAncestor(home, cwd)
				? home
				: null
	const pluginParents = [
		...(options.configuredPaths ?? []).map((path) => resolve(path)),
		...ancestorDirectories(cwd, boundary).flatMap((directory) => [
			join(directory, '.grok', 'plugins'),
			join(directory, '.claude', 'plugins'),
		]),
		join(grokHome, 'plugins'),
		...(home === null ? [] : [join(home, '.claude', 'plugins')]),
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
						.map((entry) => join(parent, entry))
				: [parent]
		for (const candidate of candidates) {
			const normalized = resolve(candidate)
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
					: basename(candidate)
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
				const path = resolve(candidate, relativePath)
				if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) skillRoots.push(path)
			}
			if (skillRoots.length === 0) continue
			seenNames.add(name)
			for (const path of skillRoots) roots.push({ name, path })
		}
	}
	return { roots, diagnostics }
})
