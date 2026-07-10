import { defineTool, webSearchToolContract, type TartTool } from '@humanlayer/tart-core'
import { Effect } from 'effect'

const defaultTimeoutMs = 25_000

export type WebSearchToolOptions = {
	readonly exaApiKey?: string
	readonly timeoutMs?: number
	readonly env?: (name: string) => string | undefined
}

type ExaSearchResponse = {
	readonly results?: ReadonlyArray<{
		readonly title?: string
		readonly url?: string
		readonly text?: string
		readonly snippet?: string
	}>
}

const stringField = (value: unknown, key: string): string | undefined => {
	if (typeof value !== 'object' || value === null || !(key in value)) return undefined
	const field = Reflect.get(value, key)
	return typeof field === 'string' ? field : undefined
}

const normalizeExaSearchResponse = (value: unknown): ExaSearchResponse => {
	if (typeof value !== 'object' || value === null || !('results' in value) || !Array.isArray(value.results)) return {}

	return {
		results: value.results.map((result) => {
			const title = stringField(result, 'title')
			const url = stringField(result, 'url')
			const text = stringField(result, 'text')
			const snippet = stringField(result, 'snippet')

			return {
				...(title === undefined ? {} : { title }),
				...(url === undefined ? {} : { url }),
				...(text === undefined ? {} : { text }),
				...(snippet === undefined ? {} : { snippet }),
			}
		}),
	}
}

const resolveExaApiKey = (options?: WebSearchToolOptions): string | undefined =>
	options?.exaApiKey ?? options?.env?.('EXA_API_KEY') ?? process.env.EXA_API_KEY

export const webSearchTool = (options?: WebSearchToolOptions): TartTool =>
	defineTool({
		...webSearchToolContract,
		handler: (params) =>
			Effect.gen(function* () {
				const apiKey = resolveExaApiKey(options)
				if (apiKey === undefined || apiKey.length === 0) {
					return yield* Effect.fail({ message: 'web_search requires EXA_API_KEY to be set' })
				}

				const controller = new AbortController()
				const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs
				const timer = setTimeout(() => controller.abort(), timeoutMs)
				const numResults = Math.min(params.numResults ?? 5, 10)

				const response = yield* Effect.tryPromise({
					try: () =>
						fetch('https://api.exa.ai/search', {
							method: 'POST',
							signal: controller.signal,
							headers: {
								'content-type': 'application/json',
								'x-api-key': apiKey,
							},
							body: JSON.stringify({
								query: params.query,
								numResults,
								contents: { text: { maxCharacters: 500 } },
							}),
						}),
					catch: (error) => ({
						message:
							error instanceof Error && error.name === 'AbortError'
								? 'Search request timed out'
								: error instanceof Error
									? error.message
									: String(error),
					}),
				}).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timer))))

				if (!response.ok) {
					return yield* Effect.fail({ message: `Search request failed with status code: ${response.status}` })
				}

				const data = yield* Effect.tryPromise({
					try: async () => {
						const data = await response.json()
						return normalizeExaSearchResponse(data)
					},
					catch: (error) => ({
						message: `Failed to parse search response: ${error instanceof Error ? error.message : String(error)}`,
					}),
				})

				return {
					results: (data.results ?? []).map((result) => ({
						title: result.title ?? '',
						url: result.url ?? '',
						snippet: result.text ?? result.snippet ?? '',
					})),
				}
			}),
	})
