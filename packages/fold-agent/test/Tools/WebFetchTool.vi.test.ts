/**
 * WebFetchTool exercised against a real loopback HTTP server (the real transport seam, per the testing
 * reference). Images use a genuine multi-kilobyte gradient bitmap that forces the convert+resize path,
 * not a 1x1 placeholder, so the assertions prove the image pipeline actually ran.
 */
import { createServer, type Server } from 'node:http'

import { it } from '@effect/vitest'
import { ToolResultContent } from '@humanlayer/fold-core'
import { Effect, Schema } from 'effect'
import { afterAll, beforeAll, expect } from 'vitest'

import { webFetchTool } from '../../src/index'
import { handlerOf, messageOf, runHandler } from '../TestHelpers'

const richHtml = [
	'<!doctype html>',
	'<html><head><title>Doc</title></head><body>',
	'<h1>Title</h1>',
	'<p>Intro with a <a href="https://example.com/docs">link</a> inside.</p>',
	'<ul><li>alpha</li><li>beta</li></ul>',
	'<pre><code>const x = 1</code></pre>',
	'</body></html>',
].join('')

/** A real 24-bit BMP with a per-pixel gradient (not a placeholder): large enough to force a resize. */
const makeGradientBmp = (width: number, height: number): Uint8Array => {
	const rowStride = Math.ceil((width * 3) / 4) * 4
	const pixelBytes = rowStride * height
	const fileSize = 54 + pixelBytes
	const bytes = new Uint8Array(fileSize)
	const view = new DataView(bytes.buffer)
	bytes[0] = 0x42 // B
	bytes[1] = 0x4d // M
	view.setUint32(2, fileSize, true)
	view.setUint32(10, 54, true) // pixel data offset
	view.setUint32(14, 40, true) // DIB header size
	view.setInt32(18, width, true)
	view.setInt32(22, height, true)
	view.setUint16(26, 1, true) // planes
	view.setUint16(28, 24, true) // bits per pixel
	view.setUint32(34, pixelBytes, true)
	for (let y = 0; y < height; y++) {
		let offset = 54 + y * rowStride
		for (let x = 0; x < width; x++) {
			bytes[offset++] = x % 256 // blue
			bytes[offset++] = y % 256 // green
			bytes[offset++] = (x + y) % 256 // red
		}
	}
	return bytes
}

/** Big-endian IHDR width of a PNG (bytes 16-19). */
const pngWidth = (bytes: Uint8Array): number =>
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16, false)

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

const fetchResult = (
	url: string,
	options?: { readonly format?: 'markdown' | 'text' | 'html'; readonly timeout?: number },
) => runHandler(handlerOf(webFetchTool())({ url, ...options }))

let server: Server
let baseUrl = ''

beforeAll(async () => {
	server = createServer((request, response) => {
		const path = request.url ?? '/'
		if (path === '/page.html') {
			response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
			response.end(richHtml)
			return
		}
		if (path === '/plain.txt') {
			response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
			response.end('plain body text')
			return
		}
		if (path === '/image.bmp') {
			response.writeHead(200, { 'content-type': 'image/bmp' })
			response.end(Buffer.from(makeGradientBmp(2100, 700)))
			return
		}
		if (path === '/huge') {
			// No content-length: the streaming cap is the only guard. 6MB in 1MB chunks trips it at 5MB.
			response.writeHead(200, { 'content-type': 'application/octet-stream' })
			response.on('error', () => {})
			for (let index = 0; index < 6; index++) response.write(Buffer.alloc(1024 * 1024, index))
			response.end()
			return
		}
		if (path === '/slow') {
			// Never respond; the client's timeout must fire.
			return
		}
		response.writeHead(404)
		response.end('not found')
	})

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	const port = typeof address === 'object' && address !== null ? address.port : 0
	baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
	server.closeAllConnections()
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

it.live('renders HTML as markdown through turndown (links, headings, lists, fenced code)', () =>
	Effect.gen(function* () {
		const markdown = firstText(yield* fetchResult(`${baseUrl}/page.html`))

		expect(markdown).toContain('# Title')
		expect(markdown).toContain('[link](https://example.com/docs)')
		expect(markdown).toMatch(/[-*]\s+alpha/)
		expect(markdown).toContain('```')
		expect(markdown).toContain('const x = 1')
	}),
)

it.live('strips tags for the text format', () =>
	Effect.gen(function* () {
		const text = firstText(yield* fetchResult(`${baseUrl}/page.html`, { format: 'text' }))

		expect(text).toContain('Title')
		expect(text).toContain('link')
		expect(text).not.toContain('<h1>')
		expect(text).not.toContain('# Title')
	}),
)

it.live('returns raw HTML for the html format', () =>
	Effect.gen(function* () {
		const raw = firstText(yield* fetchResult(`${baseUrl}/page.html`, { format: 'html' }))

		expect(raw).toContain('<h1>Title</h1>')
	}),
)

it.live('returns non-HTML bodies unchanged', () =>
	Effect.gen(function* () {
		expect(firstText(yield* fetchResult(`${baseUrl}/plain.txt`))).toBe('plain body text')
	}),
)

it.live('returns a fetched image as a resized PNG content block', () =>
	Effect.gen(function* () {
		const result = yield* fetchResult(`${baseUrl}/image.bmp`)
		const blocks = contentOf(result)

		expect(firstText(result)).toContain('Fetched image')
		expect(firstText(result)).toContain('converted from image/bmp')
		// The 2100px-wide source must be resized under the 2000px limit, proving the pipeline ran.
		expect(firstText(result)).toContain('Multiply coordinates')

		const image = blocks[1]
		if (image?.type !== 'image') throw new Error('expected an image block')
		expect(image.mimeType).toBe('image/png')

		const decoded = new Uint8Array(Buffer.from(image.data, 'base64'))
		expect(Array.from(decoded.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]) // PNG signature
		const width = pngWidth(decoded)
		expect(width).toBeGreaterThan(1)
		expect(width).toBeLessThanOrEqual(2000)
	}),
)

it.live('rejects a response that exceeds the 5MB cap while streaming', () =>
	Effect.gen(function* () {
		const failure = yield* fetchResult(`${baseUrl}/huge`).pipe(Effect.flip)

		expect(messageOf(failure)).toBe('Response too large (exceeds 5MB limit)')
	}),
)

it.live('surfaces a non-2xx status', () =>
	Effect.gen(function* () {
		const failure = yield* fetchResult(`${baseUrl}/notfound`).pipe(Effect.flip)

		expect(messageOf(failure)).toBe('Request failed with status code: 404')
	}),
)

it.live('rejects non-http(s) URLs before making a request', () =>
	Effect.gen(function* () {
		const failure = yield* fetchResult('ftp://example.com/data').pipe(Effect.flip)

		expect(messageOf(failure)).toBe('URL must start with http:// or https://')
	}),
)

it.live('times out a response that never arrives', () =>
	Effect.gen(function* () {
		const failure = yield* fetchResult(`${baseUrl}/slow`, { timeout: 300 }).pipe(Effect.flip)

		expect(messageOf(failure)).toContain('timed out')
	}),
)
