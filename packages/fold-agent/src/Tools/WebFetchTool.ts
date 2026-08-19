import {
	defineTool,
	textResult,
	webFetchToolContract,
	type FoldTool,
	type ToolResultBlock,
} from '@humanlayer/fold-core'
import { Effect, Predicate } from 'effect'
import TurndownService from 'turndown'

import { detectSupportedImageMimeType, imageSniffBytes } from './Image/Mime'
import { processImage } from './Image/Process'

const maxResponseSize = 5 * 1024 * 1024
const defaultTimeoutMs = 30_000
const maxTimeoutMs = 120_000

/** Desktop Chrome UA: bot user agents are blocked by many sites, so present as a real browser. */
const browserUserAgent =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

const stripHtmlTags = (html: string): string =>
	html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
		.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim()

/** One Turndown service per tool value: atx headings, fenced code, and no script/style/meta noise. */
const makeTurndown = (): TurndownService => {
	const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
	turndown.remove(['script', 'style', 'meta', 'link', 'noscript', 'iframe'])
	return turndown
}

/** HTML by content-type or by a leading document marker (matches the pi/agentlayer heuristic). */
const isHtml = (contentType: string, body: string): boolean => {
	if (contentType.includes('text/html')) return true
	const trimmed = body.trimStart().toLowerCase()
	return trimmed.startsWith('<!') || trimmed.startsWith('<html')
}

/**
 * The image MIME to hand the resize pipeline, or null for non-images. Prefer a magic-byte sniff (robust
 * against wrong headers); fall back to a non-SVG `image/*` content-type so mislabeled-but-real images
 * still route to `processImage`, which converts unknown formats to PNG.
 */
const imageMimeFor = (bytes: Uint8Array, contentType: string): string | null => {
	const sniffed = detectSupportedImageMimeType(bytes.subarray(0, imageSniffBytes))
	if (sniffed !== null) return sniffed
	if (contentType.startsWith('image/') && !contentType.includes('svg'))
		return contentType.split(';')[0]?.trim() ?? null
	return null
}

/** Read the response body to bytes, enforcing the 5MB cap while streaming so an oversize body never fully buffers. */
const readBytes = (response: Response): Effect.Effect<Uint8Array, { message: string }> =>
	Effect.tryPromise({
		try: async () => {
			if (response.body === null) {
				const buffered = new Uint8Array(await response.arrayBuffer())
				if (buffered.byteLength > maxResponseSize) throw new Error('Response too large (exceeds 5MB limit)')
				return buffered
			}

			const reader = response.body.getReader()
			const chunks: Array<Uint8Array> = []
			let total = 0

			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				if (value === undefined) continue
				total += value.byteLength
				if (total > maxResponseSize) {
					await reader.cancel()
					throw new Error('Response too large (exceeds 5MB limit)')
				}
				chunks.push(value)
			}

			const bytes = new Uint8Array(total)
			let offset = 0
			for (const chunk of chunks) {
				bytes.set(chunk, offset)
				offset += chunk.byteLength
			}

			return bytes
		},
		catch: (error) => ({ message: Predicate.isError(error) ? error.message : String(error) }),
	})

export const webFetchTool = (): FoldTool => {
	const turndown = makeTurndown()

	return defineTool({
		...webFetchToolContract,
		handler: (params) =>
			Effect.gen(function* () {
				if (!params.url.startsWith('http://') && !params.url.startsWith('https://')) {
					return yield* Effect.fail({ message: 'URL must start with http:// or https://' })
				}

				const timeoutMs = Math.min(params.timeout ?? defaultTimeoutMs, maxTimeoutMs)
				const controller = new AbortController()
				const timer = setTimeout(() => controller.abort(), timeoutMs)

				return yield* Effect.gen(function* () {
					const response = yield* Effect.tryPromise({
						try: () =>
							fetch(params.url, {
								signal: controller.signal,
								headers: { 'user-agent': browserUserAgent },
							}),
						catch: (error) => ({
							message:
								Predicate.isError(error) && error.name === 'AbortError'
									? `Request timed out after ${timeoutMs}ms`
									: Predicate.isError(error)
										? error.message
										: String(error),
						}),
					})

					if (!response.ok) {
						return yield* Effect.fail({ message: `Request failed with status code: ${response.status}` })
					}

					// Cheap early reject on the advertised size; the streaming read still enforces the cap when
					// the header is missing or lies.
					const contentLength = response.headers.get('content-length')
					if (contentLength !== null && Number.parseInt(contentLength, 10) > maxResponseSize) {
						return yield* Effect.fail({ message: 'Response too large (exceeds 5MB limit)' })
					}

					const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
					const bytes = yield* readBytes(response)

					// Images: normalize/resize through the shared pipeline and return a native image content block.
					// A base64 data URI in tool_result JSON is not rendered as an image by the provider (D3).
					const imageMimeType = imageMimeFor(bytes, contentType)
					if (imageMimeType !== null) {
						const processed = yield* Effect.promise(() => processImage(bytes, imageMimeType))
						if (!processed.ok) {
							return textResult(`Fetched image [${imageMimeType}]\n${processed.message}`)
						}

						const note = [
							`Fetched image [${processed.mimeType}] from ${params.url}`,
							...processed.hints,
						].join('\n')
						const blocks: Array<ToolResultBlock> = [
							{ type: 'text', text: note },
							{ type: 'image', data: processed.data, mimeType: processed.mimeType },
						]
						return { content: blocks }
					}

					const body = new TextDecoder().decode(bytes)
					const format = params.format ?? 'markdown'
					if (format === 'html') return textResult(body)
					if (!isHtml(contentType, body)) return textResult(body)
					return textResult(format === 'text' ? stripHtmlTags(body) : turndown.turndown(body))
				}).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timer))))
			}),
	})
}
