import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { applyPatchTool } from '../../src/index'
import { handlerOf, messageOf, runHandler, tempDir } from '../TestHelpers'

it.effect('applies a multi-op V4A patch: add, update with move, delete', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'app.ts'), 'function main() {\n  old()\n}\n')
		writeFileSync(join(dir, 'legacy.txt'), 'goodbye\n')

		const result = yield* runHandler(
			handlerOf(applyPatchTool({ cwd: dir }))({
				patch_text: [
					'*** Begin Patch',
					'*** Add File: docs/notes.md',
					'+# Notes',
					'+created by patch',
					'*** Update File: app.ts',
					'*** Move to: main.ts',
					'@@ function main() {',
					'-  old()',
					'+  updated()',
					'*** Delete File: legacy.txt',
					'*** End Patch',
				].join('\n'),
			}),
		)

		expect(messageOf(result)).toBe(
			'Applied patch.\nAdded: docs/notes.md\nUpdated: app.ts (moved to main.ts)\nDeleted: legacy.txt',
		)
		expect(readFileSync(join(dir, 'docs/notes.md'), 'utf-8')).toBe('# Notes\ncreated by patch\n')
		expect(readFileSync(join(dir, 'main.ts'), 'utf-8')).toBe('function main() {\n  updated()\n}\n')
		expect(existsSync(join(dir, 'app.ts'))).toBe(false)
		expect(existsSync(join(dir, 'legacy.txt'))).toBe(false)
	}),
)

it.effect('applies a raw git diff (clanka superset input)', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'x.ts'), 'keep\nremove\n')

		yield* runHandler(
			handlerOf(applyPatchTool({ cwd: dir }))({
				patch_text: [
					'diff --git a/x.ts b/x.ts',
					'index 111..222 100644',
					'--- a/x.ts',
					'+++ b/x.ts',
					'@@ -1,2 +1,2 @@',
					' keep',
					'-remove',
					'+added',
				].join('\n'),
			}),
		)

		expect(readFileSync(join(dir, 'x.ts'), 'utf-8')).toBe('keep\nadded\n')
	}),
)

it.effect('a failing hunk means zero writes (validate-then-write atomicity)', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'target.ts'), 'original content\n')

		const failure = yield* runHandler(
			handlerOf(applyPatchTool({ cwd: dir }))({
				patch_text: [
					'*** Begin Patch',
					'*** Add File: should-not-exist.txt',
					'+data',
					'*** Update File: target.ts',
					'-line that is not there',
					'+replacement',
					'*** End Patch',
				].join('\n'),
			}),
		).pipe(Effect.flip)

		expect(messageOf(failure)).toBe(
			'apply_patch verification failed: Failed to find expected lines in target.ts:\nline that is not there',
		)
		// Atomicity: the add earlier in the patch never landed.
		expect(existsSync(join(dir, 'should-not-exist.txt'))).toBe(false)
		expect(readFileSync(join(dir, 'target.ts'), 'utf-8')).toBe('original content\n')
	}),
)

it.effect('missing update target fails with the verification prefix', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir

		const failure = yield* runHandler(
			handlerOf(applyPatchTool({ cwd: dir }))({
				patch_text: ['*** Begin Patch', '*** Update File: ghost.ts', '-a', '+b', '*** End Patch'].join('\n'),
			}),
		).pipe(Effect.flip)

		expect(messageOf(failure)).toBe('apply_patch verification failed: Failed to read file to update: ghost.ts')
	}),
)

it.effect('unparseable patch text fails with the verification prefix', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir

		const failure = yield* runHandler(
			handlerOf(applyPatchTool({ cwd: dir }))({ patch_text: 'this is not a patch' }),
		).pipe(Effect.flip)

		expect(messageOf(failure)).toBe(
			'apply_patch verification failed: Invalid patch format: expected *** Begin Patch or a git/unified diff',
		)
	}),
)
