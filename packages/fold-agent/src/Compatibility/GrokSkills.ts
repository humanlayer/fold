import { homedir } from 'node:os'

import { SkillNotFoundError, type Skill, type SkillMeta, type SkillSourceService } from '@humanlayer/fold-core'
import { Effect, FileSystem, Option, Path } from 'effect'

import {
	decodeSkillFrontmatter,
	skillNameOr,
	splitSkillFile,
	type SkillFrontmatter,
	type SkillFrontmatterInvalidFields,
	type SkillFrontmatterInvalidYaml,
} from '../Skills/SkillFrontmatter'

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

const noFrontmatter: SkillFrontmatter = {}

/**
 * Build the Grok-compatible skill source. FileSystem and Path are captured here, once; `list` and
 * `load` rescan the skill roots on every call so newly added skills appear without a restart.
 */
export const makeGrokSkillSource = Effect.fn('fold.grok_compatibility.make_skill_source')(function* (
	options: GrokSkillOptions,
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

	const ancestorSkillRoots = (cwd: string, boundary: string | null): ReadonlyArray<string> => {
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
	}

	const toSkill = (skillPath: string, frontmatter: SkillFrontmatter, content: string, namespace?: string): Skill => {
		const directory = path.dirname(skillPath)
		const rawName = skillNameOr(frontmatter, path.basename(directory))
		const name = namespace === undefined ? rawName : `${namespace}:${rawName}`
		const declared = (frontmatter.description ?? '').trim()
		const description =
			declared.length > 0
				? declared
				: content
						.split(/\n\s*\n/)[0]
						?.replace(/^#+\s*/, '')
						.trim() || rawName
		return { name, description, content, baseDir: directory }
	}

	/**
	 * Grok frontmatter is optional: without it, or with fields of the wrong type, the name falls back to
	 * the directory and the description to the body's first paragraph. Unparseable YAML skips the skill.
	 */
	const loadSkill = (skillPath: string, namespace?: string): Effect.Effect<Skill | null> =>
		fs.readFileString(skillPath).pipe(
			Effect.flatMap((raw) => {
				const { frontmatter, body } = splitSkillFile(raw)
				const fields: Effect.Effect<
					SkillFrontmatter,
					SkillFrontmatterInvalidYaml | SkillFrontmatterInvalidFields
				> = Option.match(frontmatter, {
					onNone: () => Effect.succeed(noFrontmatter),
					onSome: decodeSkillFrontmatter,
				})
				return fields.pipe(
					Effect.catchTag('SkillFrontmatterInvalidFields', (error) =>
						Effect.as(
							Effect.logWarning(`skill frontmatter ignored (invalid fields): ${skillPath}`, error),
							noFrontmatter,
						),
					),
					Effect.map((decoded) => toSkill(skillPath, decoded, body, namespace)),
				)
			}),
			Effect.catch((error) => Effect.as(Effect.logWarning(`skill skipped: ${skillPath}`, error), null)),
		)

	const scanRoot = (
		root: string,
		ignoredPaths: ReadonlyArray<string>,
		namespace?: string,
	): Effect.Effect<ReadonlyArray<Skill>> =>
		Effect.gen(function* () {
			if (!(yield* exists(root))) return []
			const found: Array<Skill> = []
			const scan = (directory: string): Effect.Effect<void> =>
				Effect.gen(function* () {
					const resolvedDirectory = path.resolve(directory)
					for (const ignoredPath of ignoredPaths)
						if (resolvedDirectory === ignoredPath || isAncestor(ignoredPath, resolvedDirectory)) return
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
	const grokHome = path.resolve(options.grokHome ?? path.join(home ?? homedir(), '.grok'))
	const projectRoot = options.projectRoot === undefined ? null : path.resolve(options.projectRoot)
	const projectRootIsAncestor = projectRoot !== null && isAncestor(projectRoot, cwd)
	const homeIsAncestor = home !== null && isAncestor(home, cwd)
	const boundary = projectRootIsAncestor ? projectRoot : homeIsAncestor ? home : null
	const roots = [
		...ancestorSkillRoots(cwd, boundary),
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

	const scanSkillCatalog: Effect.Effect<ReadonlyMap<string, Skill>> = Effect.gen(function* () {
		const byName = new Map<string, Skill>()
		for (const root of roots)
			for (const skill of yield* scanRoot(path.resolve(root), ignoredPaths))
				if (!byName.has(skill.name)) byName.set(skill.name, skill)
		for (const plugin of options.pluginPaths ?? [])
			for (const skill of yield* scanRoot(path.resolve(plugin.path), ignoredPaths, plugin.name))
				if (!byName.has(skill.name)) byName.set(skill.name, skill)
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
