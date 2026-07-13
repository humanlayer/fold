import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { loadGitSnapshot, parsePorcelainV1Z, TREE_SITTER_GRAMMAR_CACHE_STATUS } from '../src/tui/GitChanges'

describe('git changes snapshot', () => {
	it('parses machine-safe status including spaces and renames', () => {
		expect(parsePorcelainV1Z('M  staged file.ts\0 M unstaged.ts\0?? new file.md\0R  new.ts\0old.ts\0')).toEqual([
			{ x: 'M', y: ' ', path: 'staged file.ts' },
			{ x: ' ', y: 'M', path: 'unstaged.ts' },
			{ x: '?', y: '?', path: 'new file.md' },
			{ x: 'R', y: ' ', path: 'new.ts' },
		])
	})

	it('includes staged, unstaged, and untracked file diffs', async () => {
		const root = await usingTempGit()
		await writeFile(`${root}/both.txt`, 'one\n')
		await run(root, ['add', 'both.txt'])
		await writeFile(`${root}/both.txt`, 'one\ntwo\n')
		await writeFile(`${root}/:(literal).txt`, 'pathspec-safe\n')
		await writeFile(`${root}/new file.txt`, 'untracked\n')

		const snapshot = await Effect.runPromise(loadGitSnapshot(root))
		expect(snapshot._tag).toBe('ready')
		if (snapshot._tag !== 'ready') return
		expect(snapshot.files.map(({ group, path }) => `${group}:${path}`)).toEqual([
			'staged:both.txt',
			'unstaged:both.txt',
			'untracked::(literal).txt',
			'untracked:new file.txt',
		])
		expect(snapshot.files[3]?.diff).toContain('+untracked')
		expect(snapshot.files.map(({ additions, deletions }) => ({ additions, deletions }))).toEqual([
			{ additions: 1, deletions: 0 },
			{ additions: 1, deletions: 0 },
			{ additions: 1, deletions: 0 },
			{ additions: 1, deletions: 0 },
		])
		expect(snapshot.files[1]?.expandedDiff).toContain('+two')
	})

	it('degrades visibly outside a repository and records the grammar gap', async () => {
		const root = await makeTemp()
		expect(await Effect.runPromise(loadGitSnapshot(root))).toMatchObject({ _tag: 'not-git' })
		expect(TREE_SITTER_GRAMMAR_CACHE_STATUS).toContain('no concrete pinned grammar source and checksum')
	})
})

const makeTemp = async (): Promise<string> => {
	return mkdtemp(join(tmpdir(), 'tart-git-'))
}

const usingTempGit = async (): Promise<string> => {
	const path = await makeTemp()
	await run(path, ['init', '--quiet'])
	return path
}

const run = async (cwd: string, args: ReadonlyArray<string>): Promise<void> => {
	await new Promise<void>((resolveRun, reject) => {
		const child = spawn('git', [...args], { cwd, shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
		let stderr = ''
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
		child.once('error', reject)
		child.once('close', (code) => (code === 0 ? resolveRun() : reject(new Error(stderr))))
	})
}
