import {
	defineTool,
	textResult,
	webFetchToolContract,
	type FoldTool,
	type ToolResultBlock,
	type ToolResultContent,
} from '@humanlayer/fold-core'
import { Duration, Effect, Option, Schema, Stream } from 'effect'
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

type WebFetchParameters = typeof webFetchToolContract.parameters.Type

/** A tool result is one message value: reuse the whole `{ message }` shape the contract already advertises. */
type WebFetchFailure = { readonly message: string }

const failWith = (message: string): Effect.Effect<never, WebFetchFailure> => Effect.fail({ message })

// --- header parsing (parse, don't validate: the Content-Length header is untrusted text) ---------------

/** The advertised body size, decoded from the raw header; `None` when absent or unparseable. */
const declaredBodySize = (headers: Headers.Headers): Option.Option<number> =>
	Headers.get(headers, 'content-length').pipe(Option.flatMap(Schema.decodeOption(Schema.NumberFromString)))

/** The lowercased content-type, or an empty string when the header is absent. */
const contentTypeOf = (headers: Headers.Headers): string =>
	Headers.get(headers, 'content-type').pipe(
		Option.map((value) => value.toLowerCase()),
		Option.getOrElse(() => ''),
	)

// --- body reading -------------------------------------------------------------------------------------

type BodyAccumulator = { readonly size: number; readonly chunks: ReadonlyArray<Uint8Array> }

/** Flatten collected chunks into one contiguous buffer. */
const concatChunks = ({ size, chunks }: BodyAccumulator): Uint8Array => {
	const out = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.length
	}
	return out
}

/**
 * Fold the body stream into bytes, failing the moment the running total crosses the 5MB cap so an
 * oversize body is never fully buffered. A mid-body transport failure narrows to the tool's message.
 */
const collectCappedBytes = (
	url: string,
	response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<Uint8Array, WebFetchFailure> =>
	Stream.runFoldEffect(
		response.stream,
		(): BodyAccumulator => ({ size: 0, chunks: [] }),
		(accumulated, chunk): Effect.Effect<BodyAccumulator, WebFetchFailure> =>
			accumulated.size + chunk.length > maxResponseSize
				? failWith(tooLargeMessage)
				: Effect.succeed({ size: accumulated.size + chunk.length, chunks: [...accumulated.chunks, chunk] }),
	).pipe(
		Effect.map(concatChunks),
		Effect.catchTag('HttpClientError', (error) =>
			failWith(`Failed to read response from ${url}: ${error.reason.message}`),
		),
	)

// --- request adapter ----------------------------------------------------------------------------------

type FetchedDocument = { readonly contentType: string; readonly bytes: Uint8Array }

/**
 * Execute the request through Effect's HTTP client, classify status, reject an over-cap body up front by
 * its declared length, then read the body under the streaming cap. Transport, status, size, and timeout
 * failures all surface as the tool's `{ message }`. Requires an `HttpClient`; the caller provides fetch.
 */
const fetchDocument = (
	url: string,
	timeoutMs: number,
): Effect.Effect<FetchedDocument, WebFetchFailure, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const response = yield* HttpClient.get(url, { headers: { 'user-agent': browserUserAgent } }).pipe(
			Effect.catchTag('HttpClientError', (error) => failWith(`Failed to fetch ${url}: ${error.reason.message}`)),
		)

		if (response.status < 200 || response.status >= 300) {
			return yield* failWith(`Request failed with status code: ${response.status}`)
		}
		if (Option.exists(declaredBodySize(response.headers), (size) => size > maxResponseSize)) {
			return yield* failWith(tooLargeMessage)
		}

		const bytes = yield* collectCappedBytes(url, response)
		return { contentType: contentTypeOf(response.headers), bytes }
	}).pipe(
		Effect.timeoutOrElse({
			duration: Duration.millis(timeoutMs),
			orElse: () => failWith(`Request timed out after ${timeoutMs}ms`),
		}),
	)

// --- rendering ----------------------------------------------------------------------------------------

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

/**
 * Turn fetched bytes into a tool result. Images go through the shared resize pipeline and return a native
 * image content block (a base64 data URI in tool_result JSON is not rendered as an image by the provider,
 * D3); everything else renders as markdown, plain text, or raw HTML per the requested format.
 */
const renderDocument = (
	url: string,
	document: FetchedDocument,
	format: 'markdown' | 'text' | 'html',
	turndown: TurndownService,
): Effect.Effect<ToolResultContent> =>
	Effect.gen(function* () {
		const imageMimeType = imageMimeFor(document.bytes, document.contentType)
		if (imageMimeType !== null) {
			const processed = yield* Effect.promise(() => processImage(document.bytes, imageMimeType))
			if (!processed.ok) {
				return textResult(`Fetched image [${imageMimeType}]\n${processed.message}`)
			}

			const note = [`Fetched image [${processed.mimeType}] from ${url}`, ...processed.hints].join('\n')
			const blocks: ReadonlyArray<ToolResultBlock> = [
				{ type: 'text', text: note },
				{ type: 'image', data: processed.data, mimeType: processed.mimeType },
			]
			return { content: blocks }
		}

		const body = new TextDecoder().decode(document.bytes)
		if (format === 'html') return textResult(body)
		if (!isHtml(document.contentType, body)) return textResult(body)
		return textResult(format === 'text' ? stripHtmlTags(body) : turndown.turndown(body))
	})

// --- tool ---------------------------------------------------------------------------------------------

export const webFetchTool = (): FoldTool => {
	const turndown = makeTurndown()

	const runWebFetch = (params: WebFetchParameters): Effect.Effect<ToolResultContent, WebFetchFailure> =>
		Effect.gen(function* () {
			if (!params.url.startsWith('http://') && !params.url.startsWith('https://')) {
				return yield* failWith('URL must start with http:// or https://')
			}

			const timeoutMs = Math.min(params.timeout ?? defaultTimeoutMs, maxTimeoutMs)
			const document = yield* fetchDocument(params.url, timeoutMs)
			return yield* renderDocument(params.url, document, params.format ?? 'markdown', turndown)
		}).pipe(
			Effect.provide(FetchHttpClient.layer),
			Effect.withSpan('tool.web_fetch', { attributes: { url: params.url } }),
		)

	return defineTool({ ...webFetchToolContract, handler: runWebFetch })
}
