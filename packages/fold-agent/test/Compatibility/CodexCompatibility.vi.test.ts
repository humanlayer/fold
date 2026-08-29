import { expect, it } from '@effect/vitest'
import { Effect, FileSystem, Path } from 'effect'

import { loadCodexCompatibility, loadCodexInstructions, makeCodexSkillSource } from '../../src/index'
import { memoryFileSystem } from '../TestHelpers'

const skill = (name: string, description: string, marker = name): string =>
	['---', `name: ${name}`, `description: ${description}`, '---', '', marker].join('\n')

it.effect('walks from home to cwd and combines override, base, and local instructions', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/home/user/.codex/AGENTS.md': 'global',
			'/home/user/AGENTS.md': 'home base',
			'/home/user/AGENTS.local.md': 'home local',
			'/home/user/work/AGENTS.md': 'workspace base must be replaced',
			'/home/user/work/AGENTS.override.md': 'workspace override',
			'/home/user/work/AGENTS.local.md': 'workspace local must not load with override',
			'/home/user/work/repo/AGENTS.local.md': 'repo local only',
			'/AGENTS.md': 'outside home boundary',
		})

		const sources = yield* loadCodexInstructions({
			cwd: '/home/user/work/repo',
			home: '/home/user',
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer))

		expect(sources.map(({ path }) => path)).toEqual([
			'/home/user/.codex/AGENTS.md',
			'/home/user/AGENTS.md',
			'/home/user/AGENTS.local.md',
			'/home/user/work/AGENTS.override.md',
			'/home/user/work/repo/AGENTS.local.md',
		])
	}),
)

it.effect('walks to the filesystem root when home is not an ancestor', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/AGENTS.md': 'root',
			'/srv/AGENTS.md': 'srv',
			'/srv/repo/AGENTS.md': 'repo',
		})
		const sources = yield* loadCodexInstructions({ cwd: '/srv/repo', home: '/home/user' }).pipe(
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.provide(Path.layer),
		)
		expect(sources.map(({ path }) => path)).toEqual(['/AGENTS.md', '/srv/AGENTS.md', '/srv/repo/AGENTS.md'])
	}),
)

it.effect('loads ancestor skills and keeps the closest skill name', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/home/user/.agents/skills/global/SKILL.md': skill('global', 'Global skill'),
			'/home/user/work/.agents/skills/shared/SKILL.md': skill('shared', 'Workspace skill', 'workspace'),
			'/home/user/work/repo/.agents/skills/shared/SKILL.md': skill('shared', 'Repo skill', 'repo'),
			'/home/user/work/repo/.agents/skills/local/SKILL.md': skill('local', 'Local skill'),
		})
		const source = yield* makeCodexSkillSource({
			cwd: '/home/user/work/repo',
			home: '/home/user',
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer))
		expect(yield* source.list).toEqual([
			{ name: 'local', description: 'Local skill' },
			{ name: 'shared', description: 'Repo skill' },
			{ name: 'global', description: 'Global skill' },
		])
		expect((yield* source.load('shared')).content).toBe('repo')
	}),
)

it.effect('loads enabled plugin skills from local or the newest cached version', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/codex/config.toml': [
				'[features]',
				'plugins = true',
				'[plugins."alpha@company"]',
				'enabled = true',
				'[plugins."semver@company"]',
				'enabled = true',
				'[plugins."disabled@company"]',
				'enabled = false',
			].join('\n'),
			'/codex/plugins/cache/company/alpha/9.0.0/.codex-plugin/plugin.json': JSON.stringify({ name: 'alpha' }),
			'/codex/plugins/cache/company/alpha/9.0.0/skills/wrong/SKILL.md': skill('wrong', 'Wrong'),
			'/codex/plugins/cache/company/alpha/local/.codex-plugin/plugin.json': JSON.stringify({ name: 'alpha' }),
			'/codex/plugins/cache/company/alpha/local/skills/right/SKILL.md': skill('right', 'Right'),
			'/codex/plugins/cache/company/semver/1.9.0/plugin.json': JSON.stringify({ name: 'semver' }),
			'/codex/plugins/cache/company/semver/1.9.0/skills/old/SKILL.md': skill('old', 'Old'),
			'/codex/plugins/cache/company/semver/1.10.0/plugin.json': JSON.stringify({ name: 'semver' }),
			'/codex/plugins/cache/company/semver/1.10.0/skills/new/SKILL.md': skill('new', 'New'),
			'/codex/plugins/cache/company/disabled/1.0.0/plugin.json': JSON.stringify({ name: 'disabled' }),
			'/codex/plugins/cache/company/disabled/1.0.0/skills/nope/SKILL.md': skill('nope', 'Nope'),
		})
		const compatibility = yield* loadCodexCompatibility({
			cwd: '/repo',
			home: '/home/user',
			codexHome: '/codex',
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer))
		const names = (yield* compatibility.skills.list).map(({ name }) => name)
		expect(names).toEqual(['alpha:right', 'semver:new'])
		expect(compatibility.diagnostics).toEqual([])
	}),
)
