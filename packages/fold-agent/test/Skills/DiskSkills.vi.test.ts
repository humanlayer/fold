/**
 * Disk skill loader tests over a custom in-memory FileSystem - the scan chain reaches the user's home
 * directory, so these tests never touch the real disk (user ruling). Covers the scan-path chain and
 * its shadowing order, name defaulting from the directory, spec validation skips, frontmatter
 * handling, and baseDir wiring.
 */
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { makeDiskSkillSource } from '../../src/index'
import { memoryFileSystem } from '../TestHelpers'

const skillFile = (name: string | null, description: string, body = 'Do the thing.'): string =>
	['---', ...(name === null ? [] : [`name: ${name}`]), `description: ${description}`, '---', '', body].join('\n')

it.effect('scans Claude and Fold roots across home, git root, and cwd with later roots shadowing', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			// Global roots: Fold shadows Claude at the same scope.
			'/home/user/.claude/skills/deploy/SKILL.md': skillFile('deploy', 'Claude global deploy skill'),
			'/home/user/.claude/skills/claude-global/SKILL.md': skillFile('claude-global', 'Claude global skill'),
			'/home/user/.fold/skills/deploy/SKILL.md': skillFile('deploy', 'Global deploy skill'),
			'/home/user/.fold/skills/lint/SKILL.md': skillFile('lint', 'Global lint skill'),
			// Repo root (cwd is a subdirectory): Agent Skills shadows Claude at the same scope.
			'/repo/.git/HEAD': 'ref: refs/heads/main',
			'/repo/.claude/skills/review/SKILL.md': skillFile('review', 'Claude repo review skill'),
			'/repo/.claude/skills/claude-repo/SKILL.md': skillFile('claude-repo', 'Claude repo skill'),
			'/repo/.agents/skills/deploy/SKILL.md': skillFile('deploy', 'Repo deploy skill'),
			'/repo/.agents/skills/review/SKILL.md': skillFile('review', 'Repo review skill'),
			// cwd roots shadow every broader scope while preserving unique Claude skills.
			'/repo/packages/app/.claude/skills/deploy/SKILL.md': skillFile('deploy', 'Claude cwd deploy skill'),
			'/repo/packages/app/.claude/skills/claude-cwd/SKILL.md': skillFile('claude-cwd', 'Claude cwd skill'),
			'/repo/packages/app/.agents/skills/deploy/SKILL.md': skillFile('deploy', 'Cwd deploy skill'),
		})

		const source = yield* makeDiskSkillSource({ fileSystem: fs, cwd: '/repo/packages/app', home: '/home/user' })
		const metas = yield* source.list

		expect(new Map(metas.map((meta) => [meta.name, meta.description]))).toEqual(
			new Map([
				['claude-global', 'Claude global skill'],
				['claude-repo', 'Claude repo skill'],
				['claude-cwd', 'Claude cwd skill'],
				['deploy', 'Cwd deploy skill'],
				['lint', 'Global lint skill'],
				['review', 'Repo review skill'],
			]),
		)
	}),
)

it.effect('loads Claude project skills independently of AGENTS.md', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/repo/.git/HEAD': 'ref: refs/heads/main',
			'/repo/AGENTS.md': 'Project instructions.',
			'/repo/.claude/skills/claude-only/SKILL.md': skillFile('claude-only', 'Claude-compatible skill'),
		})

		const source = yield* makeDiskSkillSource({ fileSystem: fs, cwd: '/repo', home: '/home/user' })

		expect(yield* source.list).toEqual([{ name: 'claude-only', description: 'Claude-compatible skill' }])
	}),
)

it.effect('skips the git-root scan when the repo root IS the cwd (no double scan)', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/repo/.git/HEAD': 'ref: refs/heads/main',
			'/repo/.agents/skills/solo/SKILL.md': skillFile('solo', 'Only skill'),
		})

		const source = yield* makeDiskSkillSource({ fileSystem: fs, cwd: '/repo', home: '/home/user' })
		const metas = yield* source.list

		expect(metas).toEqual([{ name: 'solo', description: 'Only skill' }])
	}),
)

it.effect('defaults the name from the skill directory and sets baseDir', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/cwd/.agents/skills/from-dir-name/SKILL.md': skillFile(null, 'Name comes from the directory'),
		})

		const source = yield* makeDiskSkillSource({ fileSystem: fs, cwd: '/cwd', home: '/home/user' })
		const skill = yield* source.load('from-dir-name')

		expect(skill.name).toBe('from-dir-name')
		expect(skill.baseDir).toBe('/cwd/.agents/skills/from-dir-name')
		expect(skill.content).toBe('Do the thing.')
	}),
)

it.effect('skips skills violating the spec (invalid name, missing description) without failing', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/cwd/.agents/skills/Bad--Name/SKILL.md': skillFile(null, 'Invalid directory-derived name'),
			'/cwd/.agents/skills/no-description/SKILL.md': ['---', 'name: no-description', '---', 'body'].join('\n'),
			'/cwd/.agents/skills/no-frontmatter/SKILL.md': 'just a plain markdown file',
			'/cwd/.agents/skills/good/SKILL.md': skillFile('good', 'A valid skill'),
		})

		const source = yield* makeDiskSkillSource({ fileSystem: fs, cwd: '/cwd', home: '/home/user' })
		const metas = yield* source.list

		expect(metas).toEqual([{ name: 'good', description: 'A valid skill' }])
	}),
)

it.effect('finds nested skill groups but does not recurse into a skill directory', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/cwd/.agents/skills/group/one/SKILL.md': skillFile('one', 'Grouped skill'),
			// Inside a skill dir: references/ content must NOT be scanned as another skill.
			'/cwd/.agents/skills/group/one/references/SKILL.md': skillFile('sneaky', 'Should not load'),
		})

		const source = yield* makeDiskSkillSource({ fileSystem: fs, cwd: '/cwd', home: '/home/user' })
		const metas = yield* source.list

		expect(metas).toEqual([{ name: 'one', description: 'Grouped skill' }])
	}),
)

it.effect('load fails with the roster for unknown names', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/cwd/.agents/skills/present/SKILL.md': skillFile('present', 'Here'),
		})

		const source = yield* makeDiskSkillSource({ fileSystem: fs, cwd: '/cwd', home: '/home/user' })
		const failure = yield* source.load('absent').pipe(Effect.flip)

		expect(failure._tag).toBe('SkillNotFoundError')
		if (failure._tag !== 'SkillNotFoundError') throw new Error('expected SkillNotFoundError')
		expect(failure.availableSkills).toEqual(['present'])
	}),
)

it.effect('a fresh scan per list picks up newly added skills (the refresh path)', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/cwd/.agents/skills/first/SKILL.md': skillFile('first', 'Original'),
		})

		const source = yield* makeDiskSkillSource({ fileSystem: fs, cwd: '/cwd', home: '/home/user' })
		expect((yield* source.list).map((meta) => meta.name)).toEqual(['first'])

		// Write a new skill through the same in-memory filesystem.
		yield* fs.writeFileString('/cwd/.agents/skills/second/SKILL.md', skillFile('second', 'Added later'))

		expect((yield* source.list).map((meta) => meta.name)).toEqual(['first', 'second'])
	}),
)

it.effect('parses CRLF SKILL.md files without corrupting fields (trailing \\r regression)', () =>
	Effect.gen(function* () {
		const crlfSkill = ['---', 'description: Written on Windows', 'name: crlf-skill', '---', '', 'Body line.'].join(
			'\r\n',
		)
		const fs = memoryFileSystem({ '/cwd/.agents/skills/crlf-skill/SKILL.md': crlfSkill })

		const source = yield* makeDiskSkillSource({ fileSystem: fs, cwd: '/cwd', home: '/home/user' })
		const skill = yield* source.load('crlf-skill')

		// name is last in the frontmatter: without CRLF normalization it would carry a trailing \r
		// and fail spec validation, dropping the skill entirely.
		expect(skill.name).toBe('crlf-skill')
		expect(skill.description).toBe('Written on Windows')
		expect(skill.content).toBe('Body line.')
	}),
)

it.effect('supports extra scan roots with highest precedence', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/cwd/.agents/skills/tool/SKILL.md': skillFile('tool', 'From cwd'),
			'/extra/skills/tool/SKILL.md': skillFile('tool', 'From extra root'),
		})

		const source = yield* makeDiskSkillSource({
			fileSystem: fs,
			cwd: '/cwd',
			home: '/home/user',
			extraPaths: ['/extra/skills'],
		})

		expect(yield* source.list).toEqual([{ name: 'tool', description: 'From extra root' }])
	}),
)
