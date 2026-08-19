import {
	defineTool,
	textResult,
	webFetchToolContract,
	type FoldTool,
	type ToolResultBlock,
} from '@humanlayer/fold-core'
import { Duration, Effect, Option, Stream } from 'effect'
import { FetchHttpClient, Headers, HttpClient } from 'effect/unstable/http'
import type { HttpClientResponse } from 'effect/unstable/http'
import TurndownService from 'turndown'

import { detectSupportedImageMimeType, imageSniffBytes } from './Image/Mime'
import { processImage } from './Image/Process'

const maxResponseSize = 5 * 1024 * 1024
const defaultTimeoutMs = 30_000
const maxTimeoutMs = 120_000
const tooLargeMessage = 'Response too large (exceeds 5MB limit)'

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

/** Flatten the collected body chunks into one contiguous buffer. */
const concatChunks = (chunks: ReadonlyArray<Uint8Array>, size: number): Uint8Array => {
	const out = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.length
	}
	return out
}

type BodyAccumulator = { readonly size: number; readonly chunks: ReadonlyArray<Uint8Array> }

/**
 * Fold the response body stream into bytes, failing the moment the running total crosses the 5MB cap so
 * an oversize body is never fully buffered. Transport failures mid-body narrow to the tool's message.
 */
const collectCappedBytes = (
	url: string,
	response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<Uint8Array, { message: string }> =>
	Stream.runFoldEffect(
		response.stream,
		(): BodyAccumulator => ({ size: 0, chunks: [] }),
		(accumulated, chunk): Effect.Effect<BodyAccumulator, { readonly message: string }> =>
			accumulated.size + chunk.length > maxResponseSize
				? Effect.fail({ message: tooLargeMessage })
				: Effect.succeed({ size: accumulated.size + chunk.length, chunks: [...accumulated.chunks, chunk] }),
	).pipe(
		Effect.map((accumulated) => concatChunks(accumulated.chunks, accumulated.size)),
		Effect.catchTag('HttpClientError', (error) =>
			Effect.fail({ message: `Failed to read response from ${url}: ${error.reason.message}` }),
		),
	)

export const webFetchTool = (): FoldTool => {
	const turndown = makeTurndown()

	const fetchAndRender = (params: typeof webFetchToolContract.parameters.Type) =>
		Effect.gen(function* () {
			const response = yield* HttpClient.get(params.url, {
				headers: { 'user-agent': browserUserAgent },
			}).pipe(
				Effect.catchTag('HttpClientError', (error) =>
					Effect.fail({ message: `Failed to fetch ${params.url}: ${error.reason.message}` }),
				),
			)

			if (response.status < 200 || response.status >= 300) {
				return yield* Effect.fail({ message: `Request failed with status code: ${response.status}` })
			}

			const contentType = Headers.get(response.headers, 'content-type').pipe(
				Option.map((value) => value.toLowerCase()),
				Option.getOrElse(() => ''),
			)
			const bytes = yield* collectCappedBytes(params.url, response)

			// Images: normalize/resize through the shared pipeline and return a native image content block.
			// A base64 data URI in tool_result JSON is not rendered as an image by the provider (D3).
			const imageMimeType = imageMimeFor(bytes, contentType)
			if (imageMimeType !== null) {
				const processed = yield* Effect.promise(() => processImage(bytes, imageMimeType))
				if (!processed.ok) {
					return textResult(`Fetched image [${imageMimeType}]\n${processed.message}`)
				}

				const note = [`Fetched image [${processed.mimeType}] from ${params.url}`, ...processed.hints].join('\n')
				const blocks: ReadonlyArray<ToolResultBlock> = [
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
		})

	return defineTool({
		...webFetchToolContract,
		handler: (params) =>
			Effect.gen(function* () {
				if (!params.url.startsWith('http://') && !params.url.startsWith('https://')) {
					return yield* Effect.fail({ message: 'URL must start with http:// or https://' })
				}

				const timeoutMs = Math.min(params.timeout ?? defaultTimeoutMs, maxTimeoutMs)

				return yield* fetchAndRender(params).pipe(
					Effect.timeoutOrElse({
						duration: Duration.millis(timeoutMs),
						orElse: () => Effect.fail({ message: `Request timed out after ${timeoutMs}ms` }),
					}),
					Effect.provide(FetchHttpClient.layer),
				)
			}).pipe(Effect.withSpan('tool.web_fetch', { attributes: { 'web_fetch.url': params.url } })),
	})
}
