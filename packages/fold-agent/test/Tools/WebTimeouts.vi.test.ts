import { it } from '@effect/vitest'
import { webFetchToolContract, webSearchToolContract, type FoldTool } from '@humanlayer/fold-core'
import { Effect, Fiber, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { FetchHttpClient } from 'effect/unstable/http'
import { expect } from 'vitest'

import { webFetchTool } from '../../src/Tools/WebFetchTool'
import { webSearchTool } from '../../src/Tools/WebSearchTool'
import { handlerOf, makeAmbientServices, messageOf, realizeTool, runHandler } from '../TestHelpers'

const cases: ReadonlyArray<{
	readonly name: string
	readonly tool: () => FoldTool
	readonly params: Record<string, unknown>
	readonly timeoutMs: number
	readonly message: string
}> = [
	{
		name: 'fetch interprets fractional timeout_seconds as seconds',
		tool: webFetchTool,
		params: { url: 'https://example.com', timeout_seconds: 1.5 },
		timeoutMs: 1500,
		message: 'Request timed out after 1500ms',
	},
	{
		name: 'fetch defaults to 30 seconds',
		tool: webFetchTool,
		params: { url: 'https://example.com' },
		timeoutMs: 30_000,
		message: 'Request timed out after 30000ms',
	},
	{
		name: 'fetch caps timeout_seconds at 120 seconds',
		tool: webFetchTool,
		params: { url: 'https://example.com', timeout_seconds: 200 },
		timeoutMs: 120_000,
		message: 'Request timed out after 120000ms',
	},
	...(['exa', 'parallel'] as const).flatMap((provider) => [
		{
			name: `${provider} search interprets seconds and overrides internal milliseconds`,
			tool: () => webSearchTool({ provider, timeoutMs: 100 }),
			params: { query: 'test', timeout_seconds: 1.5 },
			timeoutMs: 1500,
			message: `${provider === 'exa' ? 'web_search_exa' : 'web_search'} request timed out`,
		},
		{
			name: `${provider} search retains the 25-second default`,
			tool: () => webSearchTool({ provider }),
			params: { query: 'test' },
			timeoutMs: 25_000,
			message: `${provider === 'exa' ? 'web_search_exa' : 'web_search'} request timed out`,
		},
		{
			name: `${provider} search retains internal timeoutMs units`,
			tool: () => webSearchTool({ provider, timeoutMs: 250 }),
			params: { query: 'test' },
			timeoutMs: 250,
			message: `${provider === 'exa' ? 'web_search_exa' : 'web_search'} request timed out`,
		},
		{
			name: `${provider} search does not inherit the fetch timeout cap`,
			tool: () => webSearchTool({ provider }),
			params: { query: 'test', timeout_seconds: 150 },
			timeoutMs: 150_000,
			message: `${provider === 'exa' ? 'web_search_exa' : 'web_search'} request timed out`,
		},
	]),
]

for (const testCase of cases) {
	it.effect(testCase.name, () =>
		Effect.gen(function* () {
			const signals: Array<AbortSignal> = []
			const fetch: typeof globalThis.fetch = Object.assign(
				(_url: string | URL | Request, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						const signal = init?.signal
						if (signal === undefined || signal === null) throw new Error('expected an abort signal')
						signals.push(signal)
						signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
							once: true,
						})
					}),
				{ preconnect: globalThis.fetch.preconnect },
			)
			// Initialize the tool first (its layer loads photon for real), so the clock only times the request.
			const ambient = yield* makeAmbientServices
			const handler = yield* realizeTool(testCase.tool()).pipe(Effect.provide(ambient.layer))
			const fiber = yield* handler(testCase.params).pipe(
				Effect.provide(ambient.layer),
				Effect.provideService(FetchHttpClient.Fetch, fetch),
				Effect.flip,
				Effect.forkChild,
			)

			yield* TestClock.adjust(testCase.timeoutMs - 1)
			expect(signals).toHaveLength(1)
			expect(signals[0]?.aborted).toBe(false)
			expect(fiber.pollUnsafe()).toBeUndefined()

			yield* TestClock.adjust(1)
			const failure = yield* Fiber.join(fiber)
			expect(messageOf(failure)).toBe(testCase.message)
			expect(signals[0]?.aborted).toBe(true)
		}),
	)
}

it.effect('web contracts decode optional numeric seconds and reject strings', () =>
	Effect.gen(function* () {
		for (const contract of [webFetchToolContract, webSearchToolContract]) {
			const params = { url: 'https://example.com', query: 'test' }
			const decode = Schema.decodeUnknownEffect(contract.parameters)
			expect(yield* decode({ ...params, timeout_seconds: 1.5 })).toHaveProperty('timeout_seconds', 1.5)
			expect(yield* decode(params)).not.toHaveProperty('timeout_seconds')
			expect(yield* decode({ ...params, timeout_seconds: '1.5' }).pipe(Effect.isFailure)).toBe(true)
		}
		expect(webFetchToolContract.parameters.fields).not.toHaveProperty('timeout')
	}),
)

it.effect('search clears its timeout after a successful response', () =>
	Effect.gen(function* () {
		const signals: Array<AbortSignal> = []
		const fetch: typeof globalThis.fetch = Object.assign(
			(_url: string | URL | Request, init?: RequestInit) => {
				const signal = init?.signal
				if (signal === undefined || signal === null) throw new Error('expected an abort signal')
				signals.push(signal)
				return Promise.resolve(
					new Response(JSON.stringify({ result: { content: [{ text: 'Search result' }] } })),
				)
			},
			{ preconnect: globalThis.fetch.preconnect },
		)
		const result = yield* runHandler(
			handlerOf(webSearchTool({ provider: 'exa' }))({ query: 'test', timeout_seconds: 1 }),
		).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))
		expect(messageOf(result)).toBe('Search result')
		yield* TestClock.adjust('2 seconds')
		expect(signals).toHaveLength(1)
		expect(signals[0]?.aborted).toBe(false)
	}),
)
