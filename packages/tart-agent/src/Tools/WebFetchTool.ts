import { defineTool, webFetchToolContract, type TartTool } from '@humanlayer/tart-core'
import { Effect } from 'effect'

const maxResponseSize = 5 * 1024 * 1024
const defaultTimeoutMs = 30_000
const maxTimeoutMs = 120_000

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

const htmlToMarkdown = (html: string): string =>
	stripHtmlTags(
		html
			.replace(/<\s*br\s*\/?\s*>/gi, '\n')
			.replace(/<\s*\/p\s*>/gi, '\n\n')
			.replace(/<\s*\/h([1-6])\s*>/gi, '\n\n')
			.replace(/<\s*h([1-6])[^>]*>/gi, (_match, level: string) => `\n\n${'#'.repeat(Number(level))} `)
			.replace(/<\s*li[^>]*>/gi, '\n- ')
			.replace(/<\s*\/li\s*>/gi, ''),
	)

const isHtml = (body: string): boolean => {
	const trimmed = body.trimStart().toLowerCase()
	return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')
}

const readBody = (response: Response): Effect.Effect<string, { message: string }> =>
	Effect.tryPromise({
		try: async () => {
			if (response.body === null) return await response.text()

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

			return new TextDecoder().decode(bytes)
		},
		catch: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
	})

export const webFetchTool = (): TartTool =>
	defineTool({
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
								headers: { 'user-agent': 'Mozilla/5.0 (compatible; tart/1.0)' },
							}),
						catch: (error) => ({
							message:
								error instanceof Error && error.name === 'AbortError'
									? `Request timed out after ${timeoutMs}ms`
									: error instanceof Error
										? error.message
										: String(error),
						}),
					})

					if (!response.ok) {
						return yield* Effect.fail({ message: `Request failed with status code: ${response.status}` })
					}

					const body = yield* readBody(response)
					const format = params.format ?? 'markdown'
					if (format === 'html') return body
					if (!isHtml(body)) return body
					return format === 'text' ? stripHtmlTags(body) : htmlToMarkdown(body)
				}).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timer))))
			}),
	})
