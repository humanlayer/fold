/**
 * WebFetchTool exercised against a real loopback HTTP server (the real transport seam, per the testing
 * reference). The image case serves a genuine 128x128 photograph (`fixtures/hopper.png`, the standard
 * Pillow test image), so the assertions prove the tool fetches and returns a real image, not a
 * hand-built placeholder.
 */
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'

import { it } from '@effect/vitest'
import { ToolResultContent } from '@humanlayer/fold-core'
import { Effect, Schema } from 'effect'
import { afterAll, beforeAll, expect } from 'vitest'

import { webFetchTool } from '../../src/index'
import { handlerOf, messageOf, runHandler } from '../TestHelpers'

const hopperPng = readFileSync(new URL('../fixtures/hopper.png', import.meta.url))
const hopperBase64 = hopperPng.toString('base64')

const richHtml = [
	'<!doctype html>',
	'<html><head><title>Doc</title></head><body>',
	'<h1>Title</h1>',
	'<p>Intro with a <a href="https://example.com/docs">link</a> inside.</p>',
	'<ul><li>alpha</li><li>beta</li></ul>',
	'<pre><code>const x = 1</code></pre>',
	'</body></html>',
].join('')

/** Width/height read from a PNG IHDR (bytes 16-23, big-endian). */
const pngDimensions = (bytes: Uint8Array): { readonly width: number; readonly height: number } => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	return { width: view.getUint32(16, false), height: view.getUint32(20, false) }
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
		if (path === '/photo.png') {
			response.writeHead(200, { 'content-type': 'image/png' })
			response.end(hopperPng)
			return
		}
		if (path === '/streamed-huge') {
			// No content-length: the streaming cap is the only guard. 6MB in 1MB chunks trips it at 5MB.
			response.writeHead(200, { 'content-type': 'application/octet-stream' })
			response.on('error', () => {})
			for (let index = 0; index < 6; index++) response.write(Buffer.alloc(1024 * 1024, index))
			response.end()
			return
		}
		if (path === '/declared-huge') {
			// Advertises 6MB but sends almost nothing: only the content-length precheck can reject this.
			response.writeHead(200, {
				'content-type': 'application/octet-stream',
				'content-length': String(6 * 1024 * 1024),
			})
			response.on('error', () => {})
			response.end(Buffer.alloc(16))
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

it.live('returns a fetched PNG photo as an image content block', () =>
	Effect.gen(function* () {
		const result = yield* fetchResult(`${baseUrl}/photo.png`)
		const blocks = contentOf(result)

		expect(firstText(result)).toContain('Fetched image [image/png]')

		const image = blocks[1]
		if (image?.type !== 'image') throw new Error('expected an image block')
		expect(image.mimeType).toBe('image/png')
		// A real 128x128 photo is within the resize limits, so it round-trips byte-for-byte.
		expect(image.data).toBe(hopperBase64)

		const decoded = new Uint8Array(Buffer.from(image.data, 'base64'))
		expect(Array.from(decoded.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]) // PNG signature
		expect(pngDimensions(decoded)).toEqual({ width: 128, height: 128 })
	}),
)

it.live('rejects up front when the declared content-length exceeds the cap', () =>
	Effect.gen(function* () {
		const failure = yield* fetchResult(`${baseUrl}/declared-huge`).pipe(Effect.flip)

		expect(messageOf(failure)).toBe('Response too large (exceeds 5MB limit)')
	}),
)

it.live('rejects while streaming when an unmeasured body exceeds the cap', () =>
	Effect.gen(function* () {
		const failure = yield* fetchResult(`${baseUrl}/streamed-huge`).pipe(Effect.flip)

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
