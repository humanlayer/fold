import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Effect, Schema } from 'effect'

export type GitChangeGroup = 'staged' | 'unstaged' | 'untracked'

export type GitChange = {
	readonly key: string
	readonly group: GitChangeGroup
	readonly status: string
	readonly path: string
	readonly additions: number
	readonly deletions: number
	readonly diff: string
	readonly expandedDiff: string
	readonly patchHash: string
}

export type GitSnapshot =
	| { readonly _tag: 'ready'; readonly files: ReadonlyArray<GitChange> }
	| { readonly _tag: 'loading'; readonly message: string }
	| { readonly _tag: 'not-git'; readonly message: string }
	| { readonly _tag: 'error'; readonly message: string }

export class GitSnapshotError extends Schema.TaggedErrorClass<GitSnapshotError>()('GitSnapshotError', {
	message: Schema.String,
}) {}

type StatusEntry = { readonly x: string; readonly y: string; readonly path: string }

export const parsePorcelainV1Z = (output: string): ReadonlyArray<StatusEntry> => {
	const fields = output.split('\0')
	const entries: Array<StatusEntry> = []
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]
		if (field === undefined || field.length < 4) continue
		const x = field.charAt(0)
		const y = field.charAt(1)
		const path = field.slice(3)
		if (x === 'R' || x === 'C' || y === 'R' || y === 'C') index++
		entries.push({ x, y, path })
	}
	return entries
}

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
	Effect.tryPromise({
		try: () =>
			new Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>(
				(resolveRun, reject) => {
					const child = spawn('git', [...args], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
					let stdout = ''
					let stderr = ''
					child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
					child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
					child.once('error', reject)
					child.once('close', (code) => resolveRun({ stdout, stderr, exitCode: code ?? 1 }))
				},
			),
		catch: (error) => new GitSnapshotError({ message: String(error) }),
	})

const untrackedDiff = (path: string, content: string): string => {
	const lines = content.length === 0 ? [] : content.replace(/\n$/, '').split('\n')
	return [
		`diff --git a/${path} b/${path}`,
		'new file mode 100644',
		'--- /dev/null',
		`+++ b/${path}`,
		`@@ -0,0 +1,${lines.length} @@`,
		...lines.map((line) => `+${line}`),
	].join('\n')
}

const diffCounts = (diff: string): { readonly additions: number; readonly deletions: number } => {
	let additions = 0
	let deletions = 0
	for (const line of diff.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
		else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
	}
	return { additions, deletions }
}

export const patchHash = (diff: string): string => createHash('sha256').update(diff).digest('hex')

const readUntracked = (cwd: string, path: string) =>
	Effect.tryPromise({
		try: async () => {
			const absolutePath = resolve(cwd, path)
			const details = await stat(absolutePath)
			if (details.size > 512_000)
				return untrackedDiff(path, `[Binary or large untracked file: ${details.size} bytes]`)
			return untrackedDiff(path, await readFile(absolutePath, 'utf8'))
		},
		catch: (error) => new GitSnapshotError({ message: String(error) }),
	}).pipe(Effect.orElseSucceed(() => untrackedDiff(path, `[Unreadable untracked file: ${path}]`)))

const trackedChange = (cwd: string, group: 'staged' | 'unstaged', status: string, path: string) =>
	Effect.gen(function* () {
		const base = group === 'staged' ? ['--literal-pathspecs', 'diff', '--cached'] : ['--literal-pathspecs', 'diff']
		const flags = ['--no-color', '--no-ext-diff']
		const compact = yield* runGit(cwd, [...base, ...flags, '--', path])
		const expanded = yield* runGit(cwd, [...base, ...flags, '--unified=999999', '--', path])
		if (compact.exitCode !== 0)
			return yield* new GitSnapshotError({ message: compact.stderr.trim() || 'git diff failed' })
		return {
			key: `${group}:${path}`,
			group,
			status,
			path,
			...diffCounts(compact.stdout),
			diff: compact.stdout,
			expandedDiff: expanded.exitCode === 0 ? expanded.stdout : compact.stdout,
			patchHash: patchHash(compact.stdout),
		} satisfies GitChange
	})

export const loadGitSnapshot = (cwd: string): Effect.Effect<GitSnapshot, never> =>
	Effect.gen(function* () {
		const status = yield* runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
		if (status.exitCode !== 0) {
			const message = status.stderr.trim()
			return message.includes('not a git repository')
				? ({ _tag: 'not-git', message: 'NOT A GIT REPOSITORY' } as const)
				: ({ _tag: 'error', message: message || 'GIT STATUS FAILED' } as const)
		}
		const effects: Array<Effect.Effect<GitChange, GitSnapshotError>> = []
		for (const entry of parsePorcelainV1Z(status.stdout)) {
			if (entry.x === '?' && entry.y === '?') {
				effects.push(
					readUntracked(cwd, entry.path).pipe(
						Effect.map((diff) => ({
							key: `untracked:${entry.path}`,
							group: 'untracked' as const,
							status: '??',
							path: entry.path,
							...diffCounts(diff),
							diff,
							expandedDiff: diff,
							patchHash: patchHash(diff),
						})),
					),
				)
				continue
			}
			if (entry.x !== ' ' && entry.x !== '?') effects.push(trackedChange(cwd, 'staged', entry.x, entry.path))
			if (entry.y !== ' ' && entry.y !== '?') effects.push(trackedChange(cwd, 'unstaged', entry.y, entry.path))
		}
		const groupOrder: Record<GitChangeGroup, number> = { staged: 0, unstaged: 1, untracked: 2 }
		const files = (yield* Effect.all(effects, { concurrency: 4 })).toSorted(
			(left, right) => groupOrder[left.group] - groupOrder[right.group] || left.path.localeCompare(right.path),
		)
		return { _tag: 'ready', files } as const
	}).pipe(Effect.catch((error) => Effect.succeed({ _tag: 'error', message: error.message } as const)))

export const TREE_SITTER_GRAMMAR_CACHE_STATUS =
	'Outstanding: no concrete pinned grammar source and checksum is present; syntax grammars are not downloaded.'
