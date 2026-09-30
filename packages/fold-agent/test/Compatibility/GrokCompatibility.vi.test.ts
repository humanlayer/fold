import { homedir } from 'node:os'

import { expect, it } from '@effect/vitest'
import type { FoldSkills } from '@humanlayer/fold-core'
import { Effect, FileSystem, Path } from 'effect'

import { loadGrokCompatibility, loadGrokInstructions } from '../../src/index'
import { memoryFileSystem } from '../TestHelpers'

/** Build a loader's skill source over the test's in-memory filesystem. */
const skillsIn = (skills: FoldSkills<FileSystem.FileSystem | Path.Path>, fs: FileSystem.FileSystem) =>
	skills.make.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer))

const skill = (name: string, description: string, marker = name): string =>
	['---', `name: ${name}`, `description: ${description}`, '---', '', marker].join('\n')

it.effect('loads Grok global and root-to-cwd instructions while respecting gitignore', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/home/user/.grok/AGENTS.md': 'global grok',
			'/home/user/.grok/rules/a.md': '---\nglobs: src/**\n---\nglobal rule',
			'/home/user/.claude/CLAUDE.md': 'global claude compatibility',
			'/repo/.gitignore': '.grok/rules/ignored.md\n',
			'/repo/AGENTS.md': 'repo agents',
			'/repo/CLAUDE.md': 'repo claude',
			'/repo/.grok/rules/a.md': 'repo grok rule',
			'/repo/.grok/rules/ignored.md': 'must not load',
			'/repo/.claude/rules/a.md': 'repo claude rule',
			'/repo/apps/AGENT.md': 'apps agent',
			'/repo/apps/service/.cursor/rules/z.md': 'service cursor rule',
		})

		const sources = yield* loadGrokInstructions({
			cwd: '/repo/apps/service',
			projectRoot: '/repo',
			home: '/home/user',
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer))

		expect(sources.map(({ content }) => content)).toEqual([
			'global grok',
			'global rule',
			'global claude compatibility',
			'repo claude',
			'repo agents',
			'repo grok rule',
			'repo claude rule',
			'apps agent',
			'service cursor rule',
		])
	}),
)

it.effect('loads Grok, Agents, Claude, configured, and plugin skills with provider-local precedence', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/repo/.grok/skills/shared/SKILL.md': skill('shared', 'Repo Grok winner', 'repo grok'),
			'/repo/.agents/skills/agents/SKILL.md': skill('agents', 'Agents compatibility'),
			'/repo/apps/.claude/skills/claude/SKILL.md': skill('claude', 'Claude compatibility'),
			'/configured/custom/SKILL.md': skill('configured', 'Configured skill'),
			'/home/user/.grok/skills/global/SKILL.md': skill('global', 'Global Grok skill'),
			'/repo/.grok/plugins/acme/plugin.json': JSON.stringify({ name: 'acme', skills: ['./custom-skills'] }),
			'/repo/.grok/plugins/acme/custom-skills/deploy/SKILL.md': skill('deploy', 'Plugin deploy'),
			'/repo/.claude/plugins/ignored/plugin.json': JSON.stringify({ name: 'acme' }),
			'/repo/.claude/plugins/ignored/skills/loser/SKILL.md': skill('loser', 'Name collision loser'),
		})

		const compatibility = yield* loadGrokCompatibility({
			cwd: '/repo/apps',
			projectRoot: '/repo',
			home: '/home/user',
			configuredPaths: ['/configured'],
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer))
		const names = (yield* (yield* skillsIn(compatibility.skills, fs)).list).map(({ name }) => name)

		expect(names).toEqual(['claude', 'shared', 'agents', 'configured', 'global', 'acme:deploy'])
		expect((yield* (yield* skillsIn(compatibility.skills, fs)).load('shared')).content).toBe('repo grok')
		expect(compatibility.diagnostics).toEqual([])
	}),
)

it.effect('keeps Codex-only roots out of Grok compatibility', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/home/user/.codex/AGENTS.md': 'codex global',
			'/home/user/.codex/skills/codex/SKILL.md': skill('codex', 'Codex only'),
			'/repo/.codex/skills/project/SKILL.md': skill('project', 'Codex project only'),
		})
		const compatibility = yield* loadGrokCompatibility({
			cwd: '/repo',
			projectRoot: '/repo',
			home: '/home/user',
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer))

		expect(compatibility.instructionBlock).toBeNull()
		expect(yield* (yield* skillsIn(compatibility.skills, fs)).list).toEqual([])
	}),
)

it.effect('reports malformed plugin metadata without failing compatibility loading', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/repo/.grok/plugins/broken/plugin.json': '{not-json',
			'/repo/.grok/plugins/unsafe/plugin.json': JSON.stringify({ name: 'unsafe', skills: ['../outside'] }),
		})
		const compatibility = yield* loadGrokCompatibility({
			cwd: '/repo',
			projectRoot: '/repo',
			home: '/home/user',
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer))

		expect(yield* (yield* skillsIn(compatibility.skills, fs)).list).toEqual([])
		expect(compatibility.diagnostics).toEqual([
			{
				stage: 'manifest',
				code: 'manifest_parse_failed',
				path: '/repo/.grok/plugins/broken/plugin.json',
			},
			{
				stage: 'manifest',
				code: 'invalid_skill_root',
				path: '/repo/.grok/plugins/unsafe/plugin.json',
			},
		])
	}),
)

it.effect('uses the operating-system home for default Grok plugin discovery', () =>
	Effect.gen(function* () {
		const home = homedir()
		const fs = memoryFileSystem({
			[`${home}/.grok/plugins/default-home/plugin.json`]: JSON.stringify({ name: 'default-home' }),
			[`${home}/.grok/plugins/default-home/skills/proof/SKILL.md`]: skill('proof', 'Default home plugin'),
		})

		const compatibility = yield* loadGrokCompatibility({ cwd: '/repo', projectRoot: '/repo' }).pipe(
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.provide(Path.layer),
		)

		expect((yield* (yield* skillsIn(compatibility.skills, fs)).list).map(({ name }) => name)).toContain(
			'default-home:proof',
		)
	}),
)

it.effect('skips malformed skill frontmatter and rejects backslash plugin roots without defects', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/repo/.grok/skills/broken/SKILL.md': '---\nname: [unterminated\n---\nBroken',
			'/repo/.grok/plugins/unsafe/plugin.json': JSON.stringify({
				name: 'unsafe',
				skills: ['..\\outside'],
			}),
		})

		const compatibility = yield* loadGrokCompatibility({
			cwd: '/repo',
			projectRoot: '/repo',
			home: '/home/user',
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer))

		expect(yield* (yield* skillsIn(compatibility.skills, fs)).list).toEqual([])
		expect(compatibility.diagnostics).toContainEqual({
			stage: 'manifest',
			code: 'invalid_skill_root',
			path: '/repo/.grok/plugins/unsafe/plugin.json',
		})
	}),
)

it.effect('falls back to the directory name and first paragraph without usable frontmatter', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/repo/.grok/skills/plain/SKILL.md': '# Plain skill\r\n\r\nMore detail.',
			'/repo/.grok/skills/typed/SKILL.md': '---\nname: 42\ndescription: Ignored\n---\n# Typed skill\n\nBody',
			'/repo/.grok/skills/named/SKILL.md': '---\nname: renamed\n---\nFirst paragraph\n\nSecond',
		})

		const compatibility = yield* loadGrokCompatibility({
			cwd: '/repo',
			projectRoot: '/repo',
			home: '',
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer))

		expect(yield* (yield* skillsIn(compatibility.skills, fs)).list).toEqual([
			{ name: 'renamed', description: 'First paragraph' },
			{ name: 'plain', description: 'Plain skill' },
			{ name: 'typed', description: 'Typed skill' },
		])
		expect((yield* (yield* skillsIn(compatibility.skills, fs)).load('plain')).content).toBe(
			'# Plain skill\n\nMore detail.',
		)
	}),
)
