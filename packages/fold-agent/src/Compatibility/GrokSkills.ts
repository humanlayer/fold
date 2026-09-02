import { homedir } from 'node:os'

import { SkillNotFoundError, type Skill, type SkillMeta, type SkillSourceService } from '@humanlayer/fold-core'
import { Effect, FileSystem, Option, Path, Schema } from 'effect'
import { parse as parseYaml } from 'yaml'

export type GrokSkillOptions = {
	readonly cwd: string
	readonly home?: string
	readonly grokHome?: string
	readonly projectRoot?: string
	readonly configuredPaths?: ReadonlyArray<string>
	readonly bundledPaths?: ReadonlyArray<string>
	readonly pluginPaths?: ReadonlyArray<{ readonly name: string; readonly path: string }>
	readonly ignoredPaths?: ReadonlyArray<string>
}

const exists = (path: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
	})

const SkillFrontmatter = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	description: Schema.optionalKey(Schema.String),
})
const decodeSkillFrontmatter = Schema.decodeUnknownOption(SkillFrontmatter)

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

const ancestorSkillRoots = (
	cwd: string,
	boundary: string | null,
): Effect.Effect<ReadonlyArray<string>, never, Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const roots: Array<string> = []
		let current = cwd
		while (true) {
			for (const vendor of ['.grok', '.agents', '.claude', '.cursor'])
				roots.push(path.join(current, vendor, 'skills'))
			if (current === boundary) break
			const parent = path.dirname(current)
			if (parent === current) break
			current = parent
		}
		return roots
	})

const loadSkill = (
	skillPath: string,
	namespace?: string,
): Effect.Effect<Skill | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		return yield* fs.readFileString(skillPath).pipe(
			Effect.flatMap((raw) =>
				Effect.try(() => {
					const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
					const directory = path.dirname(skillPath)
					let parsed: unknown = null
					let content = normalized.trim()
					if (normalized.startsWith('---\n')) {
						const end = normalized.indexOf('\n---', 4)
						if (end >= 0) {
							parsed = parseYaml(normalized.slice(4, end))
							content = normalized.slice(end + 4).trim()
						}
					}
					const record = Option.getOrUndefined(decodeSkillFrontmatter(parsed))
					const rawName =
						record?.name !== undefined && record.name.length > 0 ? record.name : path.basename(directory)
					const name = namespace === undefined ? rawName : `${namespace}:${rawName}`
					const description =
						record?.description !== undefined && record.description.trim().length > 0
							? record.description.trim()
							: content
									.split(/\n\s*\n/)[0]
									?.replace(/^#+\s*/, '')
									.trim() || rawName
					return { name, description, content, baseDir: directory }
				}),
			),
			Effect.orElseSucceed(() => null),
		)
	})

const scanRoot = (
	root: string,
	ignoredPaths: ReadonlyArray<string>,
	namespace?: string,
): Effect.Effect<ReadonlyArray<Skill>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		if (!(yield* exists(root))) return []
		const found: Array<Skill> = []
		const scan = (directory: string): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
			Effect.gen(function* () {
				const resolvedDirectory = path.resolve(directory)
				for (const ignoredPath of ignoredPaths)
					if (resolvedDirectory === ignoredPath || (yield* isAncestor(ignoredPath, resolvedDirectory))) return
				const skillPath = path.join(directory, 'SKILL.md')
				if (yield* exists(skillPath)) {
					const skill = yield* loadSkill(skillPath, namespace)
					if (skill !== null) found.push(skill)
					return
				}
				const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))
				for (const entry of [...entries].sort()) {
					if (entry.startsWith('.') || entry === 'node_modules') continue
					const child = path.join(directory, entry)
					const info = yield* fs.stat(child).pipe(Effect.orElseSucceed(() => null))
					if (info?.type === 'Directory') yield* scan(child)
				}
			})
		yield* scan(root)
		return found
	})

export const makeGrokSkillSource = Effect.fn('fold.grok_compatibility.make_skill_source')(function* (
	options: GrokSkillOptions,
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
	const roots = [
		...(yield* ancestorSkillRoots(cwd, boundary)),
		...(options.configuredPaths ?? []),
		path.join(grokHome, 'skills'),
		...(home === null
			? []
			: [
					path.join(home, '.agents', 'skills'),
					path.join(home, '.claude', 'skills'),
					path.join(home, '.cursor', 'skills'),
				]),
		...(options.bundledPaths ?? []),
	]
	const ignoredPaths = (options.ignoredPaths ?? []).map((ignoredPath) => path.resolve(ignoredPath))
	const scanSkillCatalog = Effect.fn('fold.grok_compatibility.scan_skill_catalog')(function* () {
		const byName = new Map<string, Skill>()
		for (const root of roots)
			for (const skill of yield* scanRoot(path.resolve(root), ignoredPaths))
				if (!byName.has(skill.name)) byName.set(skill.name, skill)
		for (const plugin of options.pluginPaths ?? [])
			for (const skill of yield* scanRoot(path.resolve(plugin.path), ignoredPaths, plugin.name))
				if (!byName.has(skill.name)) byName.set(skill.name, skill)
		return byName
	})
	const scanSkillCatalogWithPlatformServices = () =>
		scanSkillCatalog().pipe(
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.provideService(Path.Path, path),
		)
	return {
		list: scanSkillCatalogWithPlatformServices().pipe(
			Effect.map((skills) =>
				[...skills.values()].map(({ name, description }): SkillMeta => ({ name, description })),
			),
		),
		load: (name: string) =>
			scanSkillCatalogWithPlatformServices().pipe(
				Effect.flatMap((skills) => {
					const skill = skills.get(name)
					return skill === undefined
						? Effect.fail(new SkillNotFoundError({ name, availableSkills: [...skills.keys()] }))
						: Effect.succeed(skill)
				}),
			),
	} satisfies SkillSourceService
})
