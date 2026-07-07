import { describe, expect, it } from '@effect/vitest'
import { Effect, Result } from 'effect'

import {
	applyChunks,
	computePatch,
	HunkNotFoundError,
	parsePatch,
	PatchFileNotFoundError,
	PatchParseError,
	type PatchOp,
} from '../../src/index'

const files = (entries: Record<string, string | null>) => new Map(Object.entries(entries))

const parseAndCompute = (patchText: string, contents: Record<string, string | null>) =>
	Effect.gen(function* () {
		const ops = yield* parsePatch(patchText)
		return yield* computePatch({ ops, files: files(contents) })
	})

describe('parsePatch (V4A)', () => {
	it.effect('parses add, update, delete, and move operations from one envelope', () =>
		Effect.gen(function* () {
			const ops = yield* parsePatch(
				[
					'*** Begin Patch',
					'*** Add File: new.txt',
					'+hello',
					'+world',
					'*** Update File: src/app.ts',
					'*** Move to: src/main.ts',
					'@@ function main',
					'-  old()',
					'+  updated()',
					'*** Delete File: old.txt',
					'*** End Patch',
				].join('\n'),
			)

			expect(ops.map((op) => op._tag)).toEqual(['add', 'update', 'delete'])
			const add = ops[0]
			if (add?._tag !== 'add') throw new Error('expected add')
			expect(add.path).toBe('new.txt')
			expect(add.content).toBe('hello\nworld')

			const update = ops[1]
			if (update?._tag !== 'update') throw new Error('expected update')
			expect(update.path).toBe('src/app.ts')
			expect(update.movePath).toBe('src/main.ts')
			expect(update.chunks).toHaveLength(1)
			expect(update.chunks[0]?.context).toBe('function main')
			expect(update.chunks[0]?.oldLines).toEqual(['  old()'])
			expect(update.chunks[0]?.newLines).toEqual(['  updated()'])
		}),
	)

	it.effect('requires both Begin and End markers (opencode/agentlayer strictness)', () =>
		Effect.gen(function* () {
			const result = yield* parsePatch('*** Begin Patch\n*** Add File: a\n+x').pipe(Effect.result)

			if (!Result.isFailure(result)) throw new Error('expected parse failure')
			expect(result.failure).toBeInstanceOf(PatchParseError)
			expect(result.failure.message).toBe('Invalid patch format: missing Begin/End markers')
		}),
	)

	it.effect('rejects an empty envelope', () =>
		Effect.gen(function* () {
			const result = yield* parsePatch('*** Begin Patch\n*** End Patch').pipe(Effect.result)

			if (!Result.isFailure(result)) throw new Error('expected parse failure')
			expect(result.failure.message).toBe('patch rejected: empty patch')
		}),
	)

	it.effect('rejects empty input', () =>
		Effect.gen(function* () {
			const result = yield* parsePatch('   ').pipe(Effect.result)

			if (!Result.isFailure(result)) throw new Error('expected parse failure')
			expect(result.failure.message).toBe('patch_text is required')
		}),
	)

	it.effect('unwraps heredoc-wrapped patches', () =>
		Effect.gen(function* () {
			const ops = yield* parsePatch(
				["cat <<'EOF'", '*** Begin Patch', '*** Add File: a.txt', '+content', '*** End Patch', 'EOF'].join(
					'\n',
				),
			)

			expect(ops).toHaveLength(1)
			expect(ops[0]?._tag).toBe('add')
		}),
	)

	it.effect('records End of File anchoring on the trailing chunk', () =>
		Effect.gen(function* () {
			const ops = yield* parsePatch(
				[
					'*** Begin Patch',
					'*** Update File: a.txt',
					'-last line',
					'+LAST LINE',
					'*** End of File',
					'*** End Patch',
				].join('\n'),
			)

			const update = ops[0]
			if (update?._tag !== 'update') throw new Error('expected update')
			expect(update.chunks[0]?.isEndOfFile).toBe(true)
		}),
	)

	it.effect('drops unprefixed and blank hunk-body lines (reference parity)', () =>
		Effect.gen(function* () {
			const ops = yield* parsePatch(
				[
					'*** Begin Patch',
					'*** Update File: a.txt',
					'-old',
					'',
					'stray unprefixed line',
					'+new',
					'*** End Patch',
				].join('\n'),
			)

			const update = ops[0]
			if (update?._tag !== 'update') throw new Error('expected update')
			expect(update.chunks[0]?.oldLines).toEqual(['old'])
			expect(update.chunks[0]?.newLines).toEqual(['new'])
		}),
	)
})

describe('parsePatch (git/unified diffs - clanka superset)', () => {
	it.effect('parses a git diff with an update hunk', () =>
		Effect.gen(function* () {
			const ops = yield* parsePatch(
				[
					'diff --git a/src/x.ts b/src/x.ts',
					'index 111..222 100644',
					'--- a/src/x.ts',
					'+++ b/src/x.ts',
					'@@ -1,3 +1,3 @@',
					' keep',
					'-remove',
					'+add',
				].join('\n'),
			)

			const update = ops[0]
			if (update?._tag !== 'update') throw new Error('expected update')
			expect(update.path).toBe('src/x.ts')
			expect(update.movePath).toBeNull()
			expect(update.chunks[0]?.oldLines).toEqual(['keep', 'remove'])
			expect(update.chunks[0]?.newLines).toEqual(['keep', 'add'])
		}),
	)

	it.effect('parses /dev/null headers as add and delete', () =>
		Effect.gen(function* () {
			const ops = yield* parsePatch(
				[
					'diff --git a/created.txt b/created.txt',
					'new file mode 100644',
					'--- /dev/null',
					'+++ b/created.txt',
					'@@ -0,0 +1,2 @@',
					'+first',
					'+second',
					'diff --git a/removed.txt b/removed.txt',
					'deleted file mode 100644',
					'--- a/removed.txt',
					'+++ /dev/null',
					'@@ -1,1 +0,0 @@',
					'-gone',
				].join('\n'),
			)

			expect(ops.map((op) => op._tag)).toEqual(['add', 'delete'])
			const add = ops[0]
			if (add?._tag !== 'add') throw new Error('expected add')
			expect(add.content).toBe('first\nsecond')
		}),
	)

	it.effect('parses rename from/to into an update with movePath', () =>
		Effect.gen(function* () {
			const ops = yield* parsePatch(
				[
					'diff --git a/old-name.ts b/new-name.ts',
					'similarity index 95%',
					'rename from old-name.ts',
					'rename to new-name.ts',
					'--- a/old-name.ts',
					'+++ b/new-name.ts',
					'@@ -1,1 +1,1 @@',
					'-x',
					'+y',
				].join('\n'),
			)

			const update = ops[0]
			if (update?._tag !== 'update') throw new Error('expected update')
			expect(update.path).toBe('old-name.ts')
			expect(update.movePath).toBe('new-name.ts')
		}),
	)

	it.effect('parses a bare unified diff without the git header', () =>
		Effect.gen(function* () {
			const ops = yield* parsePatch(
				['--- a/f.txt', '+++ b/f.txt', '@@ -1,2 +1,2 @@', ' one', '-two', '+2'].join('\n'),
			)

			const update = ops[0]
			if (update?._tag !== 'update') throw new Error('expected update')
			expect(update.path).toBe('f.txt')
		}),
	)

	it.effect('rejects text that is neither an envelope nor a diff', () =>
		Effect.gen(function* () {
			const result = yield* parsePatch('just some prose').pipe(Effect.result)

			if (!Result.isFailure(result)) throw new Error('expected parse failure')
			expect(result.failure.message).toBe('Invalid patch format: expected *** Begin Patch or a git/unified diff')
		}),
	)
})

describe('applyChunks (4-pass matcher)', () => {
	const chunk = (oldLines: ReadonlyArray<string>, newLines: ReadonlyArray<string>, context = '') => ({
		context,
		oldLines,
		newLines,
		isEndOfFile: false,
	})

	it.effect('matches exactly and preserves surrounding content', () =>
		Effect.gen(function* () {
			const next = yield* applyChunks({
				content: 'a\nb\nc\n',
				chunks: [chunk(['b'], ['B'])],
				path: 'f',
			})

			expect(next).toBe('a\nB\nc\n')
		}),
	)

	it.effect('matches with the rstrip pass when the file has trailing whitespace', () =>
		Effect.gen(function* () {
			const next = yield* applyChunks({
				content: 'a   \nb\n',
				chunks: [chunk(['a'], ['A'])],
				path: 'f',
			})

			expect(next).toBe('A\nb\n')
		}),
	)

	it.effect('matches with the trim pass when indentation differs', () =>
		Effect.gen(function* () {
			const next = yield* applyChunks({
				content: '    indented\nother\n',
				chunks: [chunk(['indented'], ['replaced'])],
				path: 'f',
			})

			expect(next).toBe('replaced\nother\n')
		}),
	)

	it.effect('matches with the unicode-fold pass for smart quotes', () =>
		Effect.gen(function* () {
			const next = yield* applyChunks({
				content: 'const s = ‘hi’\n',
				chunks: [chunk(["const s = 'hi'"], ["const s = 'bye'"])],
				path: 'f',
			})

			expect(next).toBe("const s = 'bye'\n")
		}),
	)

	it.effect('uses @@ context to disambiguate repeated lines', () =>
		Effect.gen(function* () {
			const content = ['function a() {', '  return 1', '}', 'function b() {', '  return 1', '}'].join('\n')
			const next = yield* applyChunks({
				content: `${content}\n`,
				chunks: [chunk(['  return 1'], ['  return 2'], 'function b() {')],
				path: 'f',
			})

			expect(next).toBe(['function a() {', '  return 1', '}', 'function b() {', '  return 2', '}', ''].join('\n'))
		}),
	)

	it.effect('anchors End-of-File chunks to the tail', () =>
		Effect.gen(function* () {
			const next = yield* applyChunks({
				content: 'dup\nmiddle\ndup\n',
				chunks: [{ context: '', oldLines: ['dup'], newLines: ['DUP'], isEndOfFile: true }],
				path: 'f',
			})

			expect(next).toBe('dup\nmiddle\nDUP\n')
		}),
	)

	it.effect('retries dropping one trailing empty pattern line', () =>
		Effect.gen(function* () {
			const next = yield* applyChunks({
				content: 'a\nb\n',
				chunks: [chunk(['b', ''], ['B', ''])],
				path: 'f',
			})

			expect(next).toBe('a\nB\n')
		}),
	)

	it.effect('appends pure-insert chunks at end of file', () =>
		Effect.gen(function* () {
			const next = yield* applyChunks({
				content: 'a\n',
				chunks: [chunk([], ['appended'])],
				path: 'f',
			})

			expect(next).toBe('a\nappended\n')
		}),
	)

	it.effect('preserves CRLF endings across application', () =>
		Effect.gen(function* () {
			const next = yield* applyChunks({
				content: 'a\r\nb\r\n',
				chunks: [chunk(['b'], ['B'])],
				path: 'f',
			})

			expect(next).toBe('a\r\nB\r\n')
		}),
	)

	it.effect('collapses multiple trailing newlines to exactly one (reference parity)', () =>
		Effect.gen(function* () {
			const next = yield* applyChunks({
				content: 'a\nb\n\n',
				chunks: [chunk(['a'], ['A'])],
				path: 'f',
			})

			expect(next).toBe('A\nb\n')
		}),
	)

	it.effect('fails with HunkNotFoundError carrying the expected lines', () =>
		Effect.gen(function* () {
			const result = yield* applyChunks({
				content: 'a\n',
				chunks: [chunk(['missing'], ['x'])],
				path: 'target.ts',
			}).pipe(Effect.result)

			if (!Result.isFailure(result)) throw new Error('expected failure')
			expect(result.failure).toBeInstanceOf(HunkNotFoundError)
			expect(result.failure.message).toBe('Failed to find expected lines in target.ts:\nmissing')
		}),
	)

	it.effect('fails when @@ context is not found', () =>
		Effect.gen(function* () {
			const result = yield* applyChunks({
				content: 'a\n',
				chunks: [chunk(['a'], ['b'], 'no such context')],
				path: 'target.ts',
			}).pipe(Effect.result)

			if (!Result.isFailure(result)) throw new Error('expected failure')
			expect(result.failure.message).toBe("Failed to find context 'no such context' in target.ts")
		}),
	)
})

describe('computePatch', () => {
	it.effect('computes write/delete/move steps with a dry run before any IO', () =>
		Effect.gen(function* () {
			const computed = yield* parseAndCompute(
				[
					'*** Begin Patch',
					'*** Add File: added.txt',
					'+content',
					'*** Update File: moved.txt',
					'*** Move to: renamed.txt',
					'-old',
					'+new',
					'*** Delete File: removed.txt',
					'*** End Patch',
				].join('\n'),
				{ 'moved.txt': 'old\n', 'removed.txt': 'anything\n' },
			)

			expect(computed.steps).toEqual([
				{ _tag: 'write', path: 'added.txt', content: 'content\n' },
				{ _tag: 'move', fromPath: 'moved.txt', toPath: 'renamed.txt', content: 'new\n' },
				{ _tag: 'delete', path: 'removed.txt' },
			])
			expect(computed.summary).toEqual([
				'Added: added.txt',
				'Updated: moved.txt (moved to renamed.txt)',
				'Deleted: removed.txt',
			])
		}),
	)

	it.effect('fails with PatchFileNotFoundError for a missing update target', () =>
		Effect.gen(function* () {
			const result = yield* parseAndCompute(
				['*** Begin Patch', '*** Update File: gone.txt', '-a', '+b', '*** End Patch'].join('\n'),
				{ 'gone.txt': null },
			).pipe(Effect.result)

			if (!Result.isFailure(result)) throw new Error('expected failure')
			if (!(result.failure instanceof PatchFileNotFoundError)) throw new Error('expected PatchFileNotFoundError')
			expect(result.failure.message).toBe('Failed to read file to update: gone.txt')
		}),
	)

	it.effect('tracks cross-op state: updating a file deleted earlier in the patch fails', () =>
		Effect.gen(function* () {
			const result = yield* parseAndCompute(
				[
					'*** Begin Patch',
					'*** Delete File: f.txt',
					'*** Update File: f.txt',
					'-a',
					'+b',
					'*** End Patch',
				].join('\n'),
				{ 'f.txt': 'a\n' },
			).pipe(Effect.result)

			if (!Result.isFailure(result)) throw new Error('expected failure')
			expect(result.failure).toBeInstanceOf(PatchFileNotFoundError)
		}),
	)

	it.effect('tracks cross-op state: updating a file added earlier in the patch succeeds', () =>
		Effect.gen(function* () {
			const computed = yield* parseAndCompute(
				[
					'*** Begin Patch',
					'*** Add File: f.txt',
					'+a',
					'*** Update File: f.txt',
					'-a',
					'+b',
					'*** End Patch',
				].join('\n'),
				{},
			)

			expect(computed.steps[1]).toEqual({ _tag: 'write', path: 'f.txt', content: 'b\n' })
		}),
	)

	it.effect('an added file ending in a bare + line gets exactly one trailing newline', () =>
		Effect.gen(function* () {
			const computed = yield* parseAndCompute(
				['*** Begin Patch', '*** Add File: f.txt', '+a', '+', '*** End Patch'].join('\n'),
				{},
			)

			expect(computed.steps[0]).toEqual({ _tag: 'write', path: 'f.txt', content: 'a\n' })
		}),
	)

	it.effect('a git-diff add with zero hunks creates an empty file (clanka authority)', () =>
		Effect.gen(function* () {
			const computed = yield* parseAndCompute(
				['diff --git a/empty.txt b/empty.txt', 'new file mode 100644', '--- /dev/null', '+++ b/empty.txt'].join(
					'\n',
				),
				{},
			)

			expect(computed.steps[0]).toEqual({ _tag: 'write', path: 'empty.txt', content: '' })
		}),
	)

	it.effect('a failed hunk aborts before any steps are produced (validate-then-write)', () =>
		Effect.gen(function* () {
			const result = yield* parseAndCompute(
				[
					'*** Begin Patch',
					'*** Add File: first.txt',
					'+ok',
					'*** Update File: second.txt',
					'-does not exist',
					'+x',
					'*** End Patch',
				].join('\n'),
				{ 'second.txt': 'other content\n' },
			).pipe(Effect.result)

			// The whole computation fails; the caller performs no filesystem steps at all.
			if (!Result.isFailure(result)) throw new Error('expected failure')
			expect(result.failure).toBeInstanceOf(HunkNotFoundError)
		}),
	)
})

// Exercised as data to keep the type in the public surface honest.
const exampleOp: PatchOp = { _tag: 'delete', path: 'x' }
it('PatchOp stays a plain data union', () => {
	expect(exampleOp._tag).toBe('delete')
})
