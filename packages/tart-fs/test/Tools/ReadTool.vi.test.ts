import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { ToolResultContent } from '@humanlayer/tart-core'
import { Effect, Schema } from 'effect'

import { readTool } from '../../src/index'
import { messageOf, runHandler, tempDir } from '../TestHelpers'

const onePixelPngBase64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Minimal valid 1x1 24-bit BMP. */
const onePixelBmp = (): Uint8Array => {
	const bytes = new Uint8Array(58)
	const view = new DataView(bytes.buffer)
	bytes[0] = 0x42 // B
	bytes[1] = 0x4d // M
	view.setUint32(2, 58, true) // file size
	view.setUint32(10, 54, true) // pixel offset
	view.setUint32(14, 40, true) // DIB header size
	view.setInt32(18, 1, true) // width
	view.setInt32(22, 1, true) // height
	view.setUint16(26, 1, true) // planes
	view.setUint16(28, 24, true) // bpp
	view.setUint32(34, 4, true) // image size
	bytes[54] = 0xff // blue
	bytes[55] = 0x00
	bytes[56] = 0x00
	return bytes
}

const isToolResultContent = Schema.is(ToolResultContent)

const contentOf = (result: unknown): ToolResultContent['content'] => {
	if (!isToolResultContent(result)) throw new Error('expected a content-block tool result')
	return result.content
}

const firstText = (result: unknown): string => {
	const block = contentOf(result)[0]
	if (block?.type !== 'text') throw new Error('expected a text block')
	return block.text
}

it.effect('reads raw text with no line-number prefixes', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'plain.txt'), 'first line\nsecond line\n')

		const result = yield* runHandler(readTool({ cwd: dir }).handler({ path: 'plain.txt' }))

		expect(firstText(result)).toBe('first line\nsecond line\n')
	}),
)

it.effect('applies 1-indexed offset and limit with the more-lines notice', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'lines.txt'), Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join('\n'))

		const result = yield* runHandler(readTool({ cwd: dir }).handler({ path: 'lines.txt', offset: 3, limit: 2 }))

		expect(firstText(result)).toBe('line-3\nline-4\n\n[6 more lines in file. Use offset=5 to continue.]')
	}),
)

it.effect('head-truncates large files with pi verbatim notice', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const lines = Array.from({ length: 2500 }, (_, index) => `l${index + 1}`)
		writeFileSync(join(dir, 'big.txt'), lines.join('\n'))

		const result = yield* runHandler(readTool({ cwd: dir }).handler({ path: 'big.txt' }))
		const text = firstText(result)

		expect(text.endsWith('[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]')).toBe(true)
		expect(text.startsWith('l1\n')).toBe(true)
	}),
)

it.effect('redirects oversized single lines to bash', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'huge-line.txt'), 'x'.repeat(60 * 1024))

		const result = yield* runHandler(readTool({ cwd: dir }).handler({ path: 'huge-line.txt' }))

		expect(firstText(result)).toBe(
			`[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' huge-line.txt | head -c 51200]`,
		)
	}),
)

it.effect('fails with the offset-beyond-EOF message', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'short.txt'), 'only\n')

		const failure = yield* runHandler(readTool({ cwd: dir }).handler({ path: 'short.txt', offset: 99 })).pipe(
			Effect.flip,
		)

		expect(failure).toEqual({ message: 'Offset 99 is beyond end of file (2 lines total)' })
	}),
)

it.effect('fails with a model-actionable message for missing files', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir

		const failure = yield* runHandler(readTool({ cwd: dir }).handler({ path: 'nope.txt' })).pipe(Effect.flip)

		expect(messageOf(failure)).toContain('file not found: nope.txt')
	}),
)

it.effect('returns PNG images as an image content block with a note (hard requirement)', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'pixel.png'), Buffer.from(onePixelPngBase64, 'base64'))

		const result = yield* runHandler(readTool({ cwd: dir }).handler({ path: 'pixel.png' }))
		const blocks = contentOf(result)

		expect(blocks[0]?.type).toBe('text')
		expect(firstText(result)).toContain('Read image file [image/png]')

		const image = blocks[1]
		if (image?.type !== 'image') throw new Error('expected an image block')
		expect(image.mimeType).toBe('image/png')
		// Small image passes through unresized: bytes round-trip exactly.
		expect(image.data).toBe(onePixelPngBase64)
	}),
)

it.effect('converts BMP to PNG with a conversion hint', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'pixel.bmp'), onePixelBmp())

		const result = yield* runHandler(readTool({ cwd: dir }).handler({ path: 'pixel.bmp' }))
		const blocks = contentOf(result)

		expect(firstText(result)).toContain('[Image converted from image/bmp to image/png.]')
		const image = blocks[1]
		if (image?.type !== 'image') throw new Error('expected an image block')
		expect(image.mimeType).toBe('image/png')
	}),
)

it.effect('resolves macOS filename variants (curly apostrophe)', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'it’s a file.txt'), 'variant content\n')

		const result = yield* runHandler(readTool({ cwd: dir }).handler({ path: "it's a file.txt" }))

		expect(firstText(result)).toBe('variant content\n')
	}),
)
