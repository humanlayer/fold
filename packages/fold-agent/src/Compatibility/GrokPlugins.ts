import { homedir } from 'node:os'

import { Array as Arr, Effect, FileSystem, Option, Path, Schema } from 'effect'

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

const GrokPluginManifest = Schema.Struct({
	name: Schema.optional(Schema.String),
	skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
})
type GrokPluginManifest = typeof GrokPluginManifest.Type
const decodeGrokPluginManifest = Schema.decodeOption(Schema.fromJsonString(GrokPluginManifest))

/** A manifest file found on disk; `value` is null when it could not be parsed. */
type ManifestFile = { readonly path: string; readonly value: GrokPluginManifest | null }

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

const safeRelativePath = (value: string): string | null => {
	if (value.length === 0 || value.includes('\\') || value.includes('\0')) return null
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

const readManifest = (root: string): Effect.Effect<ManifestFile | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		for (const name of ['plugin.json', '.grok-plugin/plugin.json', '.claude-plugin/plugin.json']) {
			const manifestPath = path.join(root, name)
			const contents = yield* fs.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => null))
			if (contents === null) continue
			return { path: manifestPath, value: Option.getOrNull(decodeGrokPluginManifest(contents)) }
		}
		return null
	})

const resolvePluginParents = (options: GrokPluginOptions): Effect.Effect<ReadonlyArray<string>, never, Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const cwd = path.resolve(options.cwd)
		const { configuredPaths = [] } = options
		// An empty home disables every home-relative root.
		const home = Option.liftPredicate(options.home ?? homedir(), (value) => value.length > 0).pipe(
			Option.map((value) => path.resolve(value)),
		)
		const grokHome = path.resolve(options.grokHome ?? path.join(Option.getOrElse(home, homedir), '.grok'))
		const projectRoot = options.projectRoot === undefined ? null : path.resolve(options.projectRoot)
		const projectRootIsAncestor = projectRoot !== null && (yield* isAncestor(projectRoot, cwd))
		const homeIsAncestor = Option.isSome(home) && (yield* isAncestor(home.value, cwd))
		const boundary = projectRootIsAncestor ? projectRoot : homeIsAncestor ? Option.getOrNull(home) : null
		const homePluginRoot = Option.map(home, (value) => path.join(value, '.claude', 'plugins'))
		return [
			...configuredPaths.map((configuredPath) => path.resolve(configuredPath)),
			...(yield* ancestorDirectories(cwd, boundary)).flatMap((directory) => [
				path.join(directory, '.grok', 'plugins'),
				path.join(directory, '.claude', 'plugins'),
			]),
			path.join(grokHome, 'plugins'),
			...Option.toArray(homePluginRoot),
		]
	})

const listPluginCandidates = (
	parent: string,
	parentManifest: ManifestFile | null,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (parentManifest !== null) return [parent]
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		return (yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => [])))
			.sort((left, right) => left.localeCompare(right))
			.map((entry) => path.join(parent, entry))
	})

const pluginName = (manifestValue: GrokPluginManifest | null, fallback: string): string =>
	manifestValue?.name ?? fallback

const declaredSkillPaths = (manifestValue: GrokPluginManifest | null): ReadonlyArray<string> =>
	Arr.ensure(manifestValue?.skills ?? 'skills')

const resolveSkillRoots = (
	candidate: string,
	declared: ReadonlyArray<string>,
	manifestPath: string,
	diagnostics: Array<GrokPluginDiagnostic>,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const skillRoots: Array<string> = []
		for (const value of declared) {
			const relativePath = safeRelativePath(value)
			if (relativePath === null) {
				diagnostics.push({ stage: 'manifest', code: 'invalid_skill_root', path: manifestPath })
				continue
			}
			const skillRoot = path.resolve(candidate, relativePath)
			if (yield* fs.exists(skillRoot).pipe(Effect.orElseSucceed(() => false))) skillRoots.push(skillRoot)
		}
		return skillRoots
	})

export const discoverGrokPluginSkillRoots = Effect.fn('fold.grok_compatibility.discover_plugin_skills')(function* (
	options: GrokPluginOptions,
) {
	const path = yield* Path.Path
	const pluginParents = yield* resolvePluginParents(options)
	const diagnostics: Array<GrokPluginDiagnostic> = []
	const roots: Array<GrokPluginSkillRoot> = []
	const seenPaths = new Set<string>()
	const seenNames = new Set<string>()

	for (const parent of pluginParents) {
		const parentManifest = yield* readManifest(parent)
		const candidates = yield* listPluginCandidates(parent, parentManifest)
		for (const candidate of candidates) {
			const normalized = path.resolve(candidate)
			if (seenPaths.has(normalized)) continue
			seenPaths.add(normalized)
			const manifest =
				candidate === parent && parentManifest !== null ? parentManifest : yield* readManifest(candidate)
			if (manifest !== null && manifest.value === null) {
				diagnostics.push({ stage: 'manifest', code: 'manifest_parse_failed', path: manifest.path })
				continue
			}
			const manifestValue = manifest?.value ?? null
			const name = pluginName(manifestValue, path.basename(candidate))
			if (name.length === 0 || seenNames.has(name)) continue
			const skillRoots = yield* resolveSkillRoots(
				candidate,
				declaredSkillPaths(manifestValue),
				manifest?.path ?? candidate,
				diagnostics,
			)
			if (Arr.isReadonlyArrayEmpty(skillRoots)) continue
			seenNames.add(name)
			for (const skillRoot of skillRoots) roots.push({ name, path: skillRoot })
		}
	}
	return { roots, diagnostics }
})
