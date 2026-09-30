import { homedir } from 'node:os'

import { SkillNotFoundError, type Skill, type SkillMeta, type SkillSourceService } from '@humanlayer/fold-core'
import { Effect, FileSystem, Path } from 'effect'
import { parse as parseYaml } from 'yaml'

export type CodexSkillOptions = {
	readonly cwd: string
	readonly home?: string
	readonly codexHome?: string
	readonly configuredPaths?: ReadonlyArray<string>
	readonly bundledPaths?: ReadonlyArray<string>
	readonly pluginPaths?: ReadonlyArray<{ readonly name: string; readonly path: string }>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Build the Codex-compatible skill source. FileSystem and Path are captured here, once; `list` and
 * `load` rescan the skill roots on every call so newly added skills appear without a restart.
 */
export const makeCodexSkillSource = Effect.fn('fold.codex_compatibility.make_skill_source')(function* (
	options: CodexSkillOptions,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path

	const exists = (candidate: string): Effect.Effect<boolean> =>
		fs.exists(candidate).pipe(Effect.catch(() => Effect.succeed(false)))

	const isAncestor = (ancestor: string, candidate: string): boolean => {
		let current = candidate
		while (true) {
			if (current === ancestor) return true
			const parent = path.dirname(current)
			if (parent === current) return false
			current = parent
		}
	}

	const ancestorSkillRoots = (cwd: string, home: string | null): ReadonlyArray<string> => {
		const roots: Array<string> = []
		const boundary = home !== null && isAncestor(home, cwd) ? home : null
		let current = cwd
		while (true) {
			roots.push(path.join(current, '.agents', 'skills'))
			if (current === boundary) break
			const parent = path.dirname(current)
			if (parent === current) break
			current = parent
		}
		return roots
	}

	const loadSkill = (skillPath: string, namespace?: string): Effect.Effect<Skill | null> =>
		fs.readFileString(skillPath).pipe(
			Effect.map((raw) => {
				const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
				if (!normalized.startsWith('---\n')) return null
				const end = normalized.indexOf('\n---', 4)
				if (end < 0) return null
				const parsed: unknown = parseYaml(normalized.slice(4, end))
				if (
					!isRecord(parsed) ||
					typeof parsed.description !== 'string' ||
					parsed.description.trim().length === 0
				)
					return null
				const directory = path.dirname(skillPath)
				const rawName =
					typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : path.basename(directory)
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

	const scanRoot = (root: string, namespace?: string): Effect.Effect<ReadonlyArray<Skill>> =>
		Effect.gen(function* () {
			if (!(yield* exists(root))) return []
			const found: Array<Skill> = []
			const scan = (directory: string): Effect.Effect<void> =>
				Effect.gen(function* () {
					const skillPath = path.join(directory, 'SKILL.md')
					if (yield* exists(skillPath)) {
						const skill = yield* loadSkill(skillPath, namespace)
						if (skill !== null) found.push(skill)
						return
					}
					const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])))
					for (const entry of [...entries].sort()) {
						if (entry.startsWith('.') || entry === 'node_modules') continue
						const child = path.join(directory, entry)
						const info = yield* fs.stat(child).pipe(Effect.catch(() => Effect.succeed(null)))
						if (info?.type === 'Directory') yield* scan(child)
					}
				})
			yield* scan(root)
			return found
		})

	const cwd = path.resolve(options.cwd)
	const homeValue = options.home === undefined ? homedir() : options.home
	const home = homeValue.length === 0 ? null : path.resolve(homeValue)
	const codexHome = path.resolve(options.codexHome ?? path.join(home ?? homedir(), '.codex'))
	const roots = [
		...ancestorSkillRoots(cwd, home),
		...(options.configuredPaths ?? []),
		path.join(codexHome, 'skills'),
		...(home === null ? [] : [path.join(home, '.agents', 'skills')]),
		...(options.bundledPaths ?? []),
	]

	const scanSkillCatalog: Effect.Effect<ReadonlyMap<string, Skill>> = Effect.gen(function* () {
		const byName = new Map<string, Skill>()
		for (const root of roots) {
			for (const skill of yield* scanRoot(root)) if (!byName.has(skill.name)) byName.set(skill.name, skill)
		}
		for (const plugin of options.pluginPaths ?? []) {
			for (const skill of yield* scanRoot(plugin.path, plugin.name))
				if (!byName.has(skill.name)) byName.set(skill.name, skill)
		}
		return byName
	})

	const source: SkillSourceService = {
		list: scanSkillCatalog.pipe(
			Effect.map((skills) =>
				[...skills.values()].map(({ name, description }): SkillMeta => ({ name, description })),
			),
		),
		load: (name) =>
			scanSkillCatalog.pipe(
				Effect.flatMap((skills) => {
					const skill = skills.get(name)
					return skill === undefined
						? Effect.fail(new SkillNotFoundError({ name, availableSkills: [...skills.keys()] }))
						: Effect.succeed(skill)
				}),
			),
	}
	return source
})
