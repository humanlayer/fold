import { homedir } from 'node:os'

import { SkillNotFoundError, type Skill, type SkillMeta, type SkillSourceService } from '@humanlayer/fold-core'
import { Effect, FileSystem, Path } from 'effect'

import { parseSkillFile, skillNameOr } from '../Skills/SkillFrontmatter'

export type CodexSkillOptions = {
	readonly cwd: string
	readonly home?: string
	readonly codexHome?: string
	readonly configuredPaths?: ReadonlyArray<string>
	readonly bundledPaths?: ReadonlyArray<string>
	readonly pluginPaths?: ReadonlyArray<{ readonly name: string; readonly path: string }>
}

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
		fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))

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

	/** Codex requires frontmatter with a non-blank description; a read or parse failure skips the skill. */
	const loadSkill = (skillPath: string, namespace?: string): Effect.Effect<Skill | null> =>
		fs.readFileString(skillPath).pipe(
			Effect.flatMap(parseSkillFile),
			Effect.map(({ frontmatter, body }) => {
				const description = (frontmatter.description ?? '').trim()
				if (description.length === 0) return null
				const directory = path.dirname(skillPath)
				const rawName = skillNameOr(frontmatter, path.basename(directory))
				const name = namespace === undefined ? rawName : `${namespace}:${rawName}`
				return { name, description, content: body, baseDir: directory }
			}),
			Effect.catch((error) => Effect.as(Effect.logWarning(`skill skipped: ${skillPath}`, error), null)),
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
