import { CurrentAgent, defineTool, webSearchToolContract, type FoldTool } from '@humanlayer/fold-core'
import { Effect } from 'effect'

const defaultTimeoutMs = 25_000
const maxNumResults = 20
const maxContextCharacters = 50_000
const exaUrl = 'https://mcp.exa.ai/mcp'
const parallelUrl = 'https://search.parallel.ai/mcp'

export type WebSearchProvider = 'exa' | 'parallel'

export type WebSearchToolOptions = {
	readonly exaApiKey?: string
	readonly parallelApiKey?: string
	readonly provider?: WebSearchProvider
	readonly timeoutMs?: number
	readonly env?: (name: string) => string | undefined
}

const resolveEnv = (options: WebSearchToolOptions | undefined, name: string): string | undefined =>
	options?.env?.(name) ?? process.env[name]

const resolveExaUrl = (options?: WebSearchToolOptions): string => {
	const apiKey = options?.exaApiKey ?? resolveEnv(options, 'EXA_API_KEY')
	if (apiKey === undefined || apiKey.length === 0) return exaUrl
	const url = new URL(exaUrl)
	url.searchParams.set('exaApiKey', apiKey)
	return url.toString()
}

const resolveParallelHeaders = (options?: WebSearchToolOptions): Record<string, string> => {
	const apiKey = options?.parallelApiKey ?? resolveEnv(options, 'PARALLEL_API_KEY')
	return {
		'User-Agent': 'fold/1.0',
		...(apiKey === undefined || apiKey.length === 0 ? {} : { Authorization: `Bearer ${apiKey}` }),
	}
}

const checksum = (text: string): number => {
	let hash = 0
	for (let index = 0; index < text.length; index += 1) {
		hash = (hash * 31 + text.charCodeAt(index)) >>> 0
	}
	return hash
}

const selectProvider = (seed: string, options?: WebSearchToolOptions): WebSearchProvider => {
	const override =
		options?.provider ??
		resolveEnv(options, 'FOLD_WEBSEARCH_PROVIDER') ??
		resolveEnv(options, 'OPENCODE_WEBSEARCH_PROVIDER')
	if (override === 'exa' || override === 'parallel') return override
	return checksum(seed) % 2 === 0 ? 'exa' : 'parallel'
}

const textField = (value: unknown): string | undefined => {
	if (typeof value !== 'object' || value === null || !('text' in value)) return undefined
	const text = Reflect.get(value, 'text')
	return typeof text === 'string' && text.length > 0 ? text : undefined
}

const parsePayload = (payload: string): string | undefined => {
	const trimmed = payload.trim()
	if (!trimmed.startsWith('{')) return undefined

	const decoded: unknown = JSON.parse(trimmed)
	if (typeof decoded !== 'object' || decoded === null || !('result' in decoded)) return undefined
	const result = Reflect.get(decoded, 'result')
	if (typeof result !== 'object' || result === null || !('content' in result)) return undefined
	const content = Reflect.get(result, 'content')
	if (!Array.isArray(content)) return undefined

	return content.map(textField).find((text) => text !== undefined)
}

const parseMcpResponse = (body: string): Effect.Effect<string | undefined, { message: string }> =>
	Effect.try({
		try: () => {
			const direct = body.trim().length > 0 ? parsePayload(body) : undefined
			if (direct !== undefined) return direct

			for (const line of body.split('\n')) {
				if (!line.startsWith('data: ')) continue
				const text = parsePayload(line.slice(6))
				if (text !== undefined) return text
			}

			return undefined
		},
		catch: (error) => ({
			message: `Failed to parse web search response: ${error instanceof Error ? error.message : String(error)}`,
		}),
	})

const callMcp = (input: {
	readonly url: string
	readonly tool: string
	readonly arguments: Record<string, unknown>
	readonly headers?: Record<string, string>
	readonly timeoutMs: number
}): Effect.Effect<string | undefined, { message: string }> =>
	Effect.gen(function* () {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), input.timeoutMs)

		return yield* Effect.gen(function* () {
			const response = yield* Effect.tryPromise({
				try: () =>
					fetch(input.url, {
						method: 'POST',
						signal: controller.signal,
						headers: {
							accept: 'application/json, text/event-stream',
							'content-type': 'application/json',
							...(input.headers ?? {}),
						},
						body: JSON.stringify({
							jsonrpc: '2.0',
							id: 1,
							method: 'tools/call',
							params: { name: input.tool, arguments: input.arguments },
						}),
					}),
				catch: (error) => ({
					message:
						error instanceof Error && error.name === 'AbortError'
							? `${input.tool} request timed out`
							: error instanceof Error
								? error.message
								: String(error),
				}),
			})

			if (!response.ok) {
				return yield* Effect.fail({
					message: `${input.tool} request failed with status code: ${response.status}`,
				})
			}

			const body = yield* Effect.tryPromise({
				try: () => response.text(),
				catch: (error) => ({
					message: `Failed to read web search response: ${error instanceof Error ? error.message : String(error)}`,
				}),
			})
			return yield* parseMcpResponse(body)
		}).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timer))))
	})

export const webSearchTool = (options?: WebSearchToolOptions): FoldTool =>
	defineTool({
		...webSearchToolContract,
		handler: (params) =>
			Effect.gen(function* () {
				const currentAgent = yield* CurrentAgent
				const provider = selectProvider(currentAgent.agentId, options)
				const numResults = Math.min(params.numResults ?? 8, maxNumResults)
				const contextMaxCharacters = Math.min(params.contextMaxCharacters ?? 10_000, maxContextCharacters)
				const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs

				const result =
					provider === 'exa'
						? yield* callMcp({
								url: resolveExaUrl(options),
								tool: 'web_search_exa',
								arguments: {
									query: params.query,
									type: params.type ?? 'auto',
									numResults,
									livecrawl: params.livecrawl ?? 'fallback',
									contextMaxCharacters,
								},
								timeoutMs,
							})
						: yield* callMcp({
								url: parallelUrl,
								tool: 'web_search',
								arguments: {
									objective: params.query,
									search_queries: [params.query],
								},
								headers: resolveParallelHeaders(options),
								timeoutMs,
							})

				return result ?? 'No search results found. Please try a different query.'
			}),
	})
