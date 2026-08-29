import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { SkillNotFoundError, type Skill, type SkillMeta, type SkillSourceService } from '@humanlayer/fold-core'
import { Effect, FileSystem } from 'effect'
import { parse as parseYaml } from 'yaml'

export type CodexSkillOptions = {
	readonly cwd: string
	readonly home?: string
	readonly codexHome?: string
	readonly configuredPaths?: ReadonlyArray<string>
	readonly bundledPaths?: ReadonlyArray<string>
	readonly pluginPaths?: ReadonlyArray<{ readonly name: string; readonly path: string }>
}

const exists = (path: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)))
	})

const isAncestor = (ancestor: string, path: string): boolean => {
	let current = path
	while (true) {
		if (current === ancestor) return true
		const parent = dirname(current)
		if (parent === current) return false
		current = parent
	}
}

const ancestorSkillRoots = (cwd: string, home: string | null): ReadonlyArray<string> => {
	const roots: Array<string> = []
	const boundary = home !== null && isAncestor(home, cwd) ? home : null
	let current = cwd
	while (true) {
		roots.push(join(current, '.agents', 'skills'))
		if (current === boundary) break
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	return roots
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const loadSkill = (
	path: string,
	namespace?: string,
): Effect.Effect<Skill | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.readFileString(path).pipe(
			Effect.map((raw) => {
				const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
				if (!normalized.startsWith('---\n')) return null
				const end = normalized.indexOf('\n---', 4)
				if (end < 0) return null
				const parsed: unknown = parseYaml(normalized.slice(4, end))
				if (!isRecord(parsed) || typeof parsed.description !== 'string' || parsed.description.trim().length === 0)
					return null
				const directory = dirname(path)
				const rawName =
					typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : basename(directory)
				const name = namespace === undefined ? rawName : `${namespace}:${rawName}`
				return {
					name,
					description: parsed.description.trim(),
					content: normalized.slice(end + 4).trim(),
					baseDir: directory,
				}
			}),
			Effect.catch(() => Effect.succeed(null)),
		)
	})

const scanRoot = (
	root: string,
	namespace?: string,
): Effect.Effect<ReadonlyArray<Skill>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		if (!(yield* exists(root))) return []
		const found: Array<Skill> = []
		const scan = (directory: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
			Effect.gen(function* () {
				const skillPath = join(directory, 'SKILL.md')
				if (yield* exists(skillPath)) {
					const skill = yield* loadSkill(skillPath, namespace)
					if (skill !== null) found.push(skill)
					return
				}
				const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])))
				for (const entry of [...entries].sort()) {
					if (entry.startsWith('.') || entry === 'node_modules') continue
					const child = join(directory, entry)
					const info = yield* fs.stat(child).pipe(Effect.catch(() => Effect.succeed(null)))
					if (info?.type === 'Directory') yield* scan(child)
				}
			})
		yield* scan(root)
		return found
	})

export const makeCodexSkillSource = (
	options: CodexSkillOptions,
): Effect.Effect<SkillSourceService, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const cwd = resolve(options.cwd)
		const homeValue = options.home === undefined ? homedir() : options.home
		const home = homeValue.length === 0 ? null : resolve(homeValue)
		const codexHome = resolve(options.codexHome ?? join(home ?? homedir(), '.codex'))
		const roots = [
			...ancestorSkillRoots(cwd, home),
			...(options.configuredPaths ?? []),
			join(codexHome, 'skills'),
			...(home === null ? [] : [join(home, '.agents', 'skills')]),
			...(options.bundledPaths ?? []),
		]
		const scan = Effect.gen(function* () {
			const byName = new Map<string, Skill>()
			for (const root of roots) {
				for (const skill of yield* scanRoot(root))
					if (!byName.has(skill.name)) byName.set(skill.name, skill)
			}
			for (const plugin of options.pluginPaths ?? []) {
				for (const skill of yield* scanRoot(plugin.path, plugin.name))
					if (!byName.has(skill.name)) byName.set(skill.name, skill)
			}
			return byName
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs))
		return {
			list: scan.pipe(
				Effect.map((skills) =>
					[...skills.values()].map(({ name, description }): SkillMeta => ({ name, description })),
				),
			),
			load: (name) =>
				scan.pipe(
					Effect.flatMap((skills) => {
						const skill = skills.get(name)
						return skill === undefined
							? Effect.fail(new SkillNotFoundError({ name, availableSkills: [...skills.keys()] }))
							: Effect.succeed(skill)
					}),
				),
		}
	})
