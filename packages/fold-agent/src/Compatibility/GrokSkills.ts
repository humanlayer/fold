import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { SkillNotFoundError, type Skill, type SkillMeta, type SkillSourceService } from '@humanlayer/fold-core'
import { Effect, type FileSystem } from 'effect'
import { parse as parseYaml } from 'yaml'

import { fileSystemFor } from '../Fs/DefaultFileSystem'

export type GrokSkillOptions = {
	readonly cwd: string
	readonly home?: string
	readonly grokHome?: string
	readonly projectRoot?: string
	readonly fileSystem?: FileSystem.FileSystem
	readonly configuredPaths?: ReadonlyArray<string>
	readonly bundledPaths?: ReadonlyArray<string>
	readonly pluginPaths?: ReadonlyArray<{ readonly name: string; readonly path: string }>
	readonly ignoredPaths?: ReadonlyArray<string>
}

const exists = (fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean> =>
	fs.exists(path).pipe(Effect.orElseSucceed(() => false))

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

const ancestorSkillRoots = (cwd: string, boundary: string | null): ReadonlyArray<string> => {
	const roots: Array<string> = []
	let current = cwd
	while (true) {
		for (const vendor of ['.grok', '.agents', '.claude', '.cursor']) roots.push(join(current, vendor, 'skills'))
		if (current === boundary) break
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	return roots
}

const loadSkill = (fs: FileSystem.FileSystem, path: string, namespace?: string): Effect.Effect<Skill | null> =>
	fs.readFileString(path).pipe(
		Effect.flatMap((raw) =>
			Effect.try(() => {
				const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
				const directory = dirname(path)
				let parsed: unknown = null
				let content = normalized.trim()
				if (normalized.startsWith('---\n')) {
					const end = normalized.indexOf('\n---', 4)
					if (end >= 0) {
						parsed = parseYaml(normalized.slice(4, end))
						content = normalized.slice(end + 4).trim()
					}
				}
				const record = isRecord(parsed) ? parsed : {}
				const rawName =
					typeof record.name === 'string' && record.name.length > 0 ? record.name : basename(directory)
				const name = namespace === undefined ? rawName : `${namespace}:${rawName}`
				const description =
					typeof record.description === 'string' && record.description.trim().length > 0
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

const scanRoot = (
	fs: FileSystem.FileSystem,
	root: string,
	ignoredPaths: ReadonlyArray<string>,
	namespace?: string,
): Effect.Effect<ReadonlyArray<Skill>> =>
	Effect.gen(function* () {
		if (!(yield* exists(fs, root))) return []
		const found: Array<Skill> = []
		const scan = (directory: string): Effect.Effect<void> =>
			Effect.gen(function* () {
				const resolvedDirectory = resolve(directory)
				if (
					ignoredPaths.some(
						(ignored) => resolvedDirectory === ignored || isAncestor(ignored, resolvedDirectory),
					)
				)
					return
				const skillPath = join(directory, 'SKILL.md')
				if (yield* exists(fs, skillPath)) {
					const skill = yield* loadSkill(fs, skillPath, namespace)
					if (skill !== null) found.push(skill)
					return
				}
				const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))
				for (const entry of [...entries].sort()) {
					if (entry.startsWith('.') || entry === 'node_modules') continue
					const child = join(directory, entry)
					const info = yield* fs.stat(child).pipe(Effect.orElseSucceed(() => null))
					if (info?.type === 'Directory') yield* scan(child)
				}
			})
		yield* scan(root)
		return found
	})

export const makeGrokSkillSource = Effect.fn('fold.grok_compatibility.make_skill_source')((options: GrokSkillOptions) =>
	Effect.sync(() => {
		const fs = fileSystemFor(options)
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
		const roots = [
			...ancestorSkillRoots(cwd, boundary),
			...(options.configuredPaths ?? []),
			join(grokHome, 'skills'),
			...(home === null
				? []
				: [join(home, '.agents', 'skills'), join(home, '.claude', 'skills'), join(home, '.cursor', 'skills')]),
			...(options.bundledPaths ?? []),
		]
		const ignoredPaths = (options.ignoredPaths ?? []).map((path) => resolve(path))
		const scanSkillCatalog = Effect.fn('fold.grok_compatibility.scan_skill_catalog')(function* () {
			const byName = new Map<string, Skill>()
			for (const root of roots)
				for (const skill of yield* scanRoot(fs, resolve(root), ignoredPaths))
					if (!byName.has(skill.name)) byName.set(skill.name, skill)
			for (const plugin of options.pluginPaths ?? [])
				for (const skill of yield* scanRoot(fs, resolve(plugin.path), ignoredPaths, plugin.name))
					if (!byName.has(skill.name)) byName.set(skill.name, skill)
			return byName
		})
		return {
			list: scanSkillCatalog().pipe(
				Effect.map((skills) =>
					[...skills.values()].map(({ name, description }): SkillMeta => ({ name, description })),
				),
			),
			load: (name: string) =>
				scanSkillCatalog().pipe(
					Effect.flatMap((skills) => {
						const skill = skills.get(name)
						return skill === undefined
							? Effect.fail(new SkillNotFoundError({ name, availableSkills: [...skills.keys()] }))
							: Effect.succeed(skill)
					}),
				),
		} satisfies SkillSourceService
	}),
)
