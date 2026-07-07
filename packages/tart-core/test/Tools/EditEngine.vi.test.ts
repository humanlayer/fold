import { describe, expect, it } from '@effect/vitest'
import { Effect, Result } from 'effect'

import { applyEdits, EditEngineError, normalizeEditInput } from '../../src/index'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.result(effect)

const expectFailure = async <A>(effect: Effect.Effect<A, EditEngineError>): Promise<string> => {
	const result = await Effect.runPromise(run(effect))
	if (!Result.isFailure(result)) throw new Error('expected the edit to fail')
	expect(result.failure).toBeInstanceOf(EditEngineError)
	return result.failure.message
}

describe('applyEdits', () => {
	it.effect('applies one exact-match edit', () =>
		Effect.gen(function* () {
			const outcome = yield* applyEdits({
				rawContent: 'const a = 1\nconst b = 2\n',
				edits: [{ oldText: 'const b = 2', newText: 'const b = 3' }],
				path: 'file.ts',
			})

			expect(outcome.content).toBe('const a = 1\nconst b = 3\n')
			expect(outcome.editsApplied).toBe(1)
		}),
	)

	it.effect('applies multiple edits that all match the original content', () =>
		Effect.gen(function* () {
			const outcome = yield* applyEdits({
				rawContent: 'alpha\nbeta\ngamma\n',
				edits: [
					{ oldText: 'gamma', newText: 'GAMMA' },
					{ oldText: 'alpha', newText: 'ALPHA' },
				],
				path: 'f',
			})

			expect(outcome.content).toBe('ALPHA\nbeta\nGAMMA\n')
		}),
	)

	it('fails with pi verbatim message when the text is not found (single edit)', async () => {
		const message = await expectFailure(
			applyEdits({ rawContent: 'hello\n', edits: [{ oldText: 'missing', newText: 'x' }], path: 'a.txt' }),
		)

		expect(message).toBe(
			'Could not find the exact text in a.txt. The old text must match exactly including all whitespace and newlines.',
		)
	})

	it('fails with the indexed message when one of several edits is not found', async () => {
		const message = await expectFailure(
			applyEdits({
				rawContent: 'hello\nworld\n',
				edits: [
					{ oldText: 'hello', newText: 'hi' },
					{ oldText: 'missing', newText: 'x' },
				],
				path: 'a.txt',
			}),
		)

		expect(message).toBe(
			'Could not find edits[1] in a.txt. The oldText must match exactly including all whitespace and newlines.',
		)
	})

	it('fails when the text appears more than once (no replace_all by design)', async () => {
		const message = await expectFailure(
			applyEdits({ rawContent: 'dup\ndup\n', edits: [{ oldText: 'dup', newText: 'x' }], path: 'a.txt' }),
		)

		expect(message).toBe(
			'Found 2 occurrences of the text in a.txt. The text must be unique. Please provide more context to make it unique.',
		)
	})

	it('rejects overlapping edits', async () => {
		const message = await expectFailure(
			applyEdits({
				rawContent: 'abcdef\n',
				edits: [
					{ oldText: 'abcd', newText: '1' },
					{ oldText: 'cdef', newText: '2' },
				],
				path: 'a.txt',
			}),
		)

		expect(message).toBe(
			'edits[0] and edits[1] overlap in a.txt. Merge them into one edit or target disjoint regions.',
		)
	})

	it('rejects empty oldText', async () => {
		const message = await expectFailure(
			applyEdits({ rawContent: 'abc\n', edits: [{ oldText: '', newText: 'x' }], path: 'a.txt' }),
		)

		expect(message).toBe('oldText must not be empty in a.txt.')
	})

	it('rejects edits that produce identical content', async () => {
		const message = await expectFailure(
			applyEdits({ rawContent: 'abc\n', edits: [{ oldText: 'abc', newText: 'abc' }], path: 'a.txt' }),
		)

		expect(message).toBe(
			'No changes made to a.txt. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.',
		)
	})

	it.effect('falls back to normalized matching for smart quotes without touching other lines', () =>
		Effect.gen(function* () {
			// File has a curly apostrophe; the model sends a straight one.
			const rawContent = 'const label = ‘it’\nconst untouched = ‘keep’\n'
			const outcome = yield* applyEdits({
				rawContent,
				edits: [{ oldText: "const label = 'it'", newText: "const label = 'replaced'" }],
				path: 'a.ts',
			})

			// The touched line is emitted in normalized form; the untouched line keeps its curly quotes.
			expect(outcome.content).toBe("const label = 'replaced'\nconst untouched = ‘keep’\n")
		}),
	)

	it.effect('falls back to normalized matching when trailing whitespace blocks an exact multi-line match', () =>
		Effect.gen(function* () {
			// The trailing spaces before the newline make the exact two-line match fail.
			const rawContent = 'line one   \nline two\nline three\n'
			const outcome = yield* applyEdits({
				rawContent,
				edits: [{ oldText: 'line one\nline two', newText: 'line 1\nline 2' }],
				path: 'a.txt',
			})

			expect(outcome.content).toBe('line 1\nline 2\nline three\n')
		}),
	)

	it.effect('preserves CRLF line endings', () =>
		Effect.gen(function* () {
			const outcome = yield* applyEdits({
				rawContent: 'one\r\ntwo\r\nthree\r\n',
				edits: [{ oldText: 'two', newText: 'TWO' }],
				path: 'a.txt',
			})

			expect(outcome.content).toBe('one\r\nTWO\r\nthree\r\n')
		}),
	)

	it.effect('matches oldText sent with CRLF against an LF file', () =>
		Effect.gen(function* () {
			const outcome = yield* applyEdits({
				rawContent: 'one\ntwo\nthree\n',
				edits: [{ oldText: 'one\r\ntwo', newText: 'ONE\r\nTWO' }],
				path: 'a.txt',
			})

			expect(outcome.content).toBe('ONE\nTWO\nthree\n')
		}),
	)

	it.effect('tries raw oldText against the normalized base before normalizing it (pi parity)', () =>
		Effect.gen(function* () {
			// The first edit forces the normalized branch; the second edit's raw oldText "x " occurs in
			// the normalized base, so it must be consumed with its raw length (the trailing space), not
			// its normalization-shrunk form.
			const outcome = yield* applyEdits({
				rawContent: '“hi”\nx yy\n',
				edits: [
					{ oldText: '"hi"', newText: 'HI' },
					{ oldText: 'x ', newText: 'Q' },
				],
				path: 'f',
			})

			expect(outcome.content).toBe('HI\nQyy\n')
		}),
	)

	it.effect('preserves a leading BOM', () =>
		Effect.gen(function* () {
			const outcome = yield* applyEdits({
				rawContent: '﻿hello\n',
				edits: [{ oldText: 'hello', newText: 'goodbye' }],
				path: 'a.txt',
			})

			expect(outcome.content).toBe('﻿goodbye\n')
		}),
	)
})

describe('normalizeEditInput', () => {
	it.effect('passes a batch through unchanged', () =>
		Effect.gen(function* () {
			const edits = yield* normalizeEditInput({ edits: [{ oldText: 'a', newText: 'b' }] })

			expect(edits).toEqual([{ oldText: 'a', newText: 'b' }])
		}),
	)

	it.effect('parses a JSON-string edits array (models sometimes stringify it)', () =>
		Effect.gen(function* () {
			const edits = yield* normalizeEditInput({ edits: '[{"oldText":"a","newText":"b"}]' })

			expect(edits).toEqual([{ oldText: 'a', newText: 'b' }])
		}),
	)

	it.effect('appends the legacy top-level oldText/newText pair as the final edit', () =>
		Effect.gen(function* () {
			const edits = yield* normalizeEditInput({
				edits: [{ oldText: 'a', newText: 'b' }],
				oldText: 'c',
				newText: 'd',
			})

			expect(edits).toEqual([
				{ oldText: 'a', newText: 'b' },
				{ oldText: 'c', newText: 'd' },
			])
		}),
	)

	it('fails when no edits are provided (pi verbatim message)', async () => {
		const message = await expectFailure(normalizeEditInput({}))

		expect(message).toBe('Edit tool input is invalid. edits must contain at least one replacement.')
	})

	it('fails on a malformed JSON-string edits value', async () => {
		const message = await expectFailure(normalizeEditInput({ edits: 'not json' }))

		expect(message).toBe('Edit tool input is invalid. edits must be an array of {oldText, newText}.')
	})
})
