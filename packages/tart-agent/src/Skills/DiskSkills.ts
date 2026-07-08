/**
 * This file implements the disk SkillSource (D20/D24): SKILL.md discovery over the FileSystem seam
 * with the settled scan-path chain - `~/.tart/skills` (global), `$GIT_REPO_ROOT/.agents/skills` (when
 * inside a repo whose root differs from cwd), `$CWD/.agents/skills` - where later roots shadow earlier
 * ones on duplicate names. Frontmatter follows the Agent Skills spec: `name` defaults from the skill
 * directory name and is validated (lowercase a-z0-9 + hyphens, 1-64, no leading/trailing/consecutive
 * hyphens); `description` is required (max 1024). `allowed-tools` and unknown keys are preserved but
 * unused; skill content is inert text - never executed or preprocessed. Loading is lenient: invalid
 * skills are skipped with a logged warning, never a failure.
 */
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
	skillDescriptionProblem,
	skillNameProblem,
	SkillNotFoundError,
	skillSource,
	type Skill,
	type SkillMeta,
	type SkillSourceService,
	type TartSkills,
} from '@humanlayer/tart-core'
import { Effect, type FileSystem } from 'effect'
import { parse as parseYaml } from 'yaml'

import { cwdFor, fileSystemFor } from '../Fs/DefaultFileSystem'

/** Options for {@link skillsFromDisk}. */
export type DiskSkillsOptions = {
	/** Project directory the scan starts from. Defaults to `process.cwd()`. */
	readonly cwd?: string
	/** Home directory for the global `~/.tart/skills` root. Defaults to `os.homedir()`. */
	readonly home?: string
	/** FileSystem implementation override. Defaults to the Node platform filesystem. */
	readonly fileSystem?: FileSystem.FileSystem
	/** Extra scan roots appended after the standard chain (highest shadowing precedence). */
	readonly extraPaths?: ReadonlyArray<string>
}

const isDirectory = (fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean> =>
	fs.stat(path).pipe(
		Effect.map((info) => info.type === 'Directory'),
		Effect.catch(() => Effect.succeed(false)),
	)

const fileExists = (fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean> =>
	fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)))

/** Walk up from `cwd` to the filesystem root looking for a `.git` entry (worktrees keep a file). */
const findGitRoot = (fs: FileSystem.FileSystem, cwd: string): Effect.Effect<string | null> =>
	Effect.gen(function* () {
		let current = cwd
		while (true) {
			if (yield* fileExists(fs, join(current, '.git'))) return current
			const parent = dirname(current)
			if (parent === current) return null
			current = parent
		}
	})

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** Split SKILL.md into YAML frontmatter and body. Null when there is no leading `---` block. */
const extractFrontmatter = (
	rawContent: string,
): { readonly frontmatter: Record<string, unknown>; readonly body: string } | null => {
	// Normalize newlines first (pi parity): CRLF frontmatter would otherwise leave a trailing \r on
	// the last field, corrupting descriptions and failing name validation.
	const content = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
	if (!content.startsWith('---')) return null

	const endIndex = content.indexOf('\n---', 3)
	if (endIndex === -1) return null

	const rawYaml = content.slice(4, endIndex)
	const body = content.slice(endIndex + 4).trim()

	try {
		const parsed: unknown = parseYaml(rawYaml)
		if (!isRecord(parsed)) return null
		return { frontmatter: parsed, body }
	} catch {
		return null
	}
}

/** Parse and validate one SKILL.md; null (with a logged warning) when it cannot be loaded. */
const loadSkillFile = (fs: FileSystem.FileSystem, skillFilePath: string): Effect.Effect<Skill | null> =>
	Effect.gen(function* () {
		const raw = yield* fs.readFileString(skillFilePath).pipe(Effect.catch(() => Effect.succeed(null)))
		if (raw === null) {
			yield* Effect.logWarning(`skill skipped (unreadable): ${skillFilePath}`)
			return null
		}

		const parsed = extractFrontmatter(raw)
		if (parsed === null) {
			yield* Effect.logWarning(`skill skipped (missing or invalid frontmatter): ${skillFilePath}`)
			return null
		}

		const directory = dirname(skillFilePath)
		const rawName = parsed.frontmatter.name
		const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : basename(directory)
		const rawDescription = parsed.frontmatter.description
		const description = typeof rawDescription === 'string' ? rawDescription : ''

		const problem = skillNameProblem(name) ?? skillDescriptionProblem(description)
		if (problem !== null) {
			yield* Effect.logWarning(`skill skipped (${problem}): ${skillFilePath}`)
			return null
		}

		return { name, description, content: parsed.body, baseDir: directory }
	})

/**
 * Scan one root for skills, pi-style: a directory containing SKILL.md is a skill root (no deeper
 * recursion); other directories recurse; dotfiles and node_modules are skipped. Within one root the
 * first occurrence of a name wins (deterministic: entries scan in sorted order).
 */
const scanRoot = (fs: FileSystem.FileSystem, root: string): Effect.Effect<ReadonlyArray<Skill>> =>
	Effect.gen(function* () {
		if (!(yield* isDirectory(fs, root))) return []

		const found: Array<Skill> = []
		const seen = new Set<string>()

		const scanDirectory = (directory: string): Effect.Effect<void> =>
			Effect.gen(function* () {
				const skillFile = join(directory, 'SKILL.md')
				if (yield* fileExists(fs, skillFile)) {
					const skill = yield* loadSkillFile(fs, skillFile)
					if (skill !== null) {
						if (seen.has(skill.name)) {
							yield* Effect.logWarning(`skill skipped (duplicate name "${skill.name}"): ${skillFile}`)
						} else {
							seen.add(skill.name)
							found.push(skill)
						}
					}
					return
				}

				const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])))
				for (const entry of [...entries].sort()) {
					if (entry.startsWith('.') || entry === 'node_modules') continue
					const childPath = join(directory, entry)
					if (yield* isDirectory(fs, childPath)) yield* scanDirectory(childPath)
				}
			})

		yield* scanDirectory(root)
		return found
	})

/** Compute the scan-root chain in shadowing order (later wins). */
const scanRoots = (
	fs: FileSystem.FileSystem,
	options: { readonly cwd: string; readonly home: string; readonly extraPaths: ReadonlyArray<string> },
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const roots: Array<string> = [join(options.home, '.tart', 'skills')]

		const gitRoot = yield* findGitRoot(fs, options.cwd)
		if (gitRoot !== null && gitRoot !== options.cwd) roots.push(join(gitRoot, '.agents', 'skills'))
		roots.push(join(options.cwd, '.agents', 'skills'))
		roots.push(...options.extraPaths)

		return roots
	})

/** Build the disk SkillSource service. Each list/load runs a fresh scan (refresh sees new skills). */
export const makeDiskSkillSource = (options?: DiskSkillsOptions): Effect.Effect<SkillSourceService> =>
	Effect.sync(() => {
		const fs = fileSystemFor(options)
		const cwd = cwdFor(options)
		const home = options?.home ?? homedir()
		const extraPaths = options?.extraPaths ?? []

		const scan: Effect.Effect<ReadonlyMap<string, Skill>> = Effect.gen(function* () {
			const roots = yield* scanRoots(fs, { cwd, home, extraPaths })
			const byName = new Map<string, Skill>()

			// Later roots shadow earlier ones: Map.set overwrites in scan order (D24 user ruling).
			for (const root of roots) {
				for (const skill of yield* scanRoot(fs, root)) byName.set(skill.name, skill)
			}

			return byName
		})

		return {
			list: scan.pipe(
				Effect.map((byName) =>
					[...byName.values()].map(({ name, description }): SkillMeta => ({ name, description })),
				),
			),
			load: (name: string) =>
				scan.pipe(
					Effect.flatMap((byName) => {
						const skill = byName.get(name)
						return skill === undefined
							? Effect.fail(new SkillNotFoundError({ name, availableSkills: [...byName.keys()] }))
							: Effect.succeed(skill)
					}),
				),
		}
	})

/** Configure an agent's skills from disk (the standard chain + optional extra roots). */
export const skillsFromDisk = (options?: DiskSkillsOptions): TartSkills => skillSource(makeDiskSkillSource(options))
