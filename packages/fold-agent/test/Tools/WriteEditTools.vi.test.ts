import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { editTool, writeTool } from '../../src/index'
import { handlerOf, messageOf, runHandler, tempDir } from '../TestHelpers'

it.effect('write creates parent directories and the file', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir

		const result = yield* runHandler(
			handlerOf(writeTool({ cwd: dir }))({ path: 'nested/deeper/new.txt', content: 'hello fold\n' }),
		)

		expect(result).toEqual({ message: 'Successfully wrote 11 bytes to nested/deeper/new.txt' })
		expect(readFileSync(join(dir, 'nested/deeper/new.txt'), 'utf-8')).toBe('hello fold\n')
	}),
)

it.effect('write overwrites existing files and reports true UTF-8 bytes (not UTF-16 length)', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'file.txt'), 'old')

		// One emoji: 2 UTF-16 code units (pi would say 2), 4 UTF-8 bytes (fold reports 4 - D18).
		const result = yield* runHandler(handlerOf(writeTool({ cwd: dir }))({ path: 'file.txt', content: '🎉' }))

		expect(result).toEqual({ message: 'Successfully wrote 4 bytes to file.txt' })
		expect(readFileSync(join(dir, 'file.txt'), 'utf-8')).toBe('🎉')
	}),
)

it.effect('edit applies a batch and reports the pi success message', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'code.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n')

		const result = yield* runHandler(
			handlerOf(editTool({ cwd: dir }))({
				path: 'code.ts',
				edits: [
					{ oldText: 'const a = 1', newText: 'const a = 10' },
					{ oldText: 'const c = 3', newText: 'const c = 30' },
				],
			}),
		)

		expect(result).toEqual({ message: 'Successfully replaced 2 block(s) in code.ts.' })
		expect(readFileSync(join(dir, 'code.ts'), 'utf-8')).toBe('const a = 10\nconst b = 2\nconst c = 30\n')
	}),
)

it.effect('edit accepts the legacy single-pair form through the shim', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'legacy.txt'), 'alpha beta\n')

		const result = yield* runHandler(
			handlerOf(editTool({ cwd: dir }))({ path: 'legacy.txt', oldText: 'beta', newText: 'gamma' }),
		)

		expect(result).toEqual({ message: 'Successfully replaced 1 block(s) in legacy.txt.' })
		expect(readFileSync(join(dir, 'legacy.txt'), 'utf-8')).toBe('alpha gamma\n')
	}),
)

it.effect('edit surfaces engine failures as model-visible messages and leaves the file untouched', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'f.txt'), 'content\n')

		const failure = yield* runHandler(
			handlerOf(editTool({ cwd: dir }))({ path: 'f.txt', edits: [{ oldText: 'missing', newText: 'x' }] }),
		).pipe(Effect.flip)

		expect(messageOf(failure)).toBe(
			'Could not find the exact text in f.txt. The old text must match exactly including all whitespace and newlines.',
		)
		expect(readFileSync(join(dir, 'f.txt'), 'utf-8')).toBe('content\n')
	}),
)

it.effect('edit preserves CRLF endings on disk', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'crlf.txt'), 'one\r\ntwo\r\n')

		yield* runHandler(
			handlerOf(editTool({ cwd: dir }))({ path: 'crlf.txt', edits: [{ oldText: 'two', newText: 'TWO' }] }),
		)

		expect(readFileSync(join(dir, 'crlf.txt'), 'utf-8')).toBe('one\r\nTWO\r\n')
	}),
)

it.effect('edit fails for missing files with pi access-gate message, without creating them', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir

		const failure = yield* runHandler(
			handlerOf(editTool({ cwd: dir }))({ path: 'ghost.txt', edits: [{ oldText: 'a', newText: 'b' }] }),
		).pipe(Effect.flip)

		expect(messageOf(failure)).toBe('Could not edit file: ghost.txt. Error code: ENOENT.')
		expect(existsSync(join(dir, 'ghost.txt'))).toBe(false)
	}),
)

it.effect('parallel same-file mutations serialize through the mutation queue (both land)', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'shared.txt'), 'line-a\nline-b\n')
		const edit = editTool({ cwd: dir })

		// Both edits target the original content; serialization means the second sees the first's
		// write and still matches (its target line is untouched by the first edit).
		yield* Effect.all(
			[
				runHandler(handlerOf(edit)({ path: 'shared.txt', edits: [{ oldText: 'line-a', newText: 'LINE-A' }] })),
				runHandler(handlerOf(edit)({ path: 'shared.txt', edits: [{ oldText: 'line-b', newText: 'LINE-B' }] })),
			],
			{ concurrency: 2 },
		)

		expect(readFileSync(join(dir, 'shared.txt'), 'utf-8')).toBe('LINE-A\nLINE-B\n')
	}),
)
