/**
 * Agentfile discovery tests (D22) over an in-memory FileSystem: the global chain (first existing wins),
 * the project walk (root -> cwd, nearest last), per-directory base preference (AGENTS.md over
 * CLAUDE.md), the `.local.md` overlay rendered right after its directory's base (and even without one),
 * and the `<project_context>` rendering shape.
 */
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { loadMemoryFiles, memoryPromptBlock, renderMemoryFiles } from '../../src/index'
import { memoryFileSystem } from '../TestHelpers'

it.effect('collects global then root..cwd, base first then local overlay', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/home/user/.fold/AGENTS.md': 'global memory',
			'/repo/AGENTS.md': 'repo base',
			'/repo/CLAUDE.md': 'repo claude (should be shadowed by AGENTS.md)',
			'/repo/pkg/CLAUDE.md': 'pkg base',
			'/repo/pkg/AGENTS.local.md': 'pkg local overlay',
		})

		const files = yield* loadMemoryFiles({ cwd: '/repo/pkg', home: '/home/user', fileSystem: fs })

		expect(files.map((file) => file.path)).toEqual([
			'/home/user/.fold/AGENTS.md',
			'/repo/AGENTS.md',
			'/repo/pkg/CLAUDE.md',
			'/repo/pkg/AGENTS.local.md',
		])
		// AGENTS.md wins over CLAUDE.md in /repo.
		expect(files.some((file) => file.path === '/repo/CLAUDE.md')).toBe(false)
		expect(files[1]?.content).toBe('repo base')
	}),
)

it.effect('loads a local overlay even when the directory has no base file', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/repo/CLAUDE.local.md': 'local only',
		})

		const files = yield* loadMemoryFiles({ cwd: '/repo', home: '/home/user', fileSystem: fs })
		expect(files.map((file) => file.path)).toEqual(['/repo/CLAUDE.local.md'])
	}),
)

it.effect('global chain: falls through to ~/.agents then ~/.codex (first existing wins)', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({
			'/home/user/.codex/AGENTS.md': 'codex global',
			'/work/AGENTS.md': 'project',
		})

		const files = yield* loadMemoryFiles({ cwd: '/work', home: '/home/user', fileSystem: fs })
		expect(files.map((file) => file.path)).toEqual(['/home/user/.codex/AGENTS.md', '/work/AGENTS.md'])
	}),
)

it.effect('renders one project_context block with a project_instructions per file', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({ '/repo/AGENTS.md': 'do the thing' })
		const block = yield* memoryPromptBlock({ cwd: '/repo', home: '/home/user', fileSystem: fs })

		expect(block).not.toBeNull()
		expect(block ?? '').toContain('<project_context>')
		expect(block ?? '').toContain('<project_instructions path="/repo/AGENTS.md">')
		expect(block ?? '').toContain('do the thing')
	}),
)

it('renders null for an empty set', () => {
	expect(renderMemoryFiles([])).toBeNull()
})

it.effect('returns null block when no agentfiles exist for the cwd', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({ '/repo/README.md': 'not an agentfile' })
		const block = yield* memoryPromptBlock({ cwd: '/repo', home: '/home/user', fileSystem: fs })
		expect(block).toBeNull()
	}),
)
