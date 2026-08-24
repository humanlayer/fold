/**
 * loadModelCatalog flow tests (D15) over the in-memory FileSystem, a recording fake fetch seam, and a
 * fixed clock - zero network, zero real disk. Covered: a fresh cache short-circuits the fetch; a
 * stale cache refetches and rewrites the cache; a fetch failure degrades to the stale cache; no cache
 * plus a fetch failure degrades to the baked snapshot; FOLD_DISABLE_MODELS_FETCH skips the fetch
 * entirely; corrupt and wrong-version caches read as absent.
 */
import { expect, it } from '@effect/vitest'
import type { ModelCatalogEntry } from '@humanlayer/fold-core'
import { Effect, FileSystem, Layer, Ref } from 'effect'

import {
	bakedModelCatalog,
	CatalogFetchError,
	loadModelCatalog,
	modelCatalogCachePath,
	FOLD_DISABLE_MODELS_FETCH,
} from '../../src/index'
import { memoryFileSystem } from '../TestHelpers'

const foldHome = '/home/user/.fold'
const cachePath = modelCatalogCachePath(foldHome)
const fixedNow = 1_700_000_000_000
const hourMs = 60 * 60 * 1000

const cachedEntry: ModelCatalogEntry = {
	providerId: 'anthropic',
	modelId: 'cached-model',
	name: 'Cached Model',
	contextWindow: 100_000,
	maxInputTokens: null,
	maxOutputTokens: 8_000,
	reasoning: false,
	reasoningEfforts: null,
	vision: false,
	toolCall: true,
	pricing: null,
}

const cacheFile = (fetchedAt: number): string => JSON.stringify({ version: 1, fetchedAt, entries: [cachedEntry] })

/** A minimal models.dev payload whose single model normalizes to a `fetched/fetched-model` entry. */
const fetchedPayload = {
	fetched: {
		models: {
			'fetched-model': {
				name: 'Fetched Model',
				reasoning: false,
				tool_call: true,
				limit: { context: 50_000, output: 4_000 },
			},
		},
	},
}

/** A fetch seam that counts calls and yields the given outcome. */
const recordingFetch = (outcome: Effect.Effect<unknown, CatalogFetchError>) =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)

		return {
			calls: Ref.get(calls),
			fetchJson: (_url: string) => Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(outcome)),
		}
	})

const failingOutcome = Effect.fail(new CatalogFetchError({ message: 'network unreachable' }))

it.effect('a fresh cache short-circuits the fetch', () =>
	Effect.gen(function* () {
		const fetch = yield* recordingFetch(Effect.succeed(fetchedPayload))

		const entries = yield* loadModelCatalog({
			foldHome,
			fetchJson: fetch.fetchJson,
			now: Effect.succeed(fixedNow),
		})

		expect(entries).toEqual([cachedEntry])
		expect(yield* fetch.calls).toBe(0)
	}).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, memoryFileSystem({ [cachePath]: cacheFile(fixedNow - hourMs) })))),
)

it.effect('a stale cache refetches, returns the live entries, and rewrites the cache', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const fetch = yield* recordingFetch(Effect.succeed(fetchedPayload))

		const entries = yield* loadModelCatalog({
			foldHome,
			fetchJson: fetch.fetchJson,
			now: Effect.succeed(fixedNow),
		})

		expect(yield* fetch.calls).toBe(1)
		expect(entries).toHaveLength(1)
		expect(entries[0]?.providerId).toBe('fetched')
		expect(entries[0]?.modelId).toBe('fetched-model')

		// The cache was rewritten with the fresh fetch time and the normalized entries.
		const written: unknown = JSON.parse(yield* fs.readFileString(cachePath))
		expect(written).toEqual({ version: 1, fetchedAt: fixedNow, entries })
	}).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, memoryFileSystem({ [cachePath]: cacheFile(fixedNow - 25 * hourMs) })))),
)

it.effect('a fetch failure degrades to the stale cache with a warning', () =>
	Effect.gen(function* () {
		const fetch = yield* recordingFetch(failingOutcome)

		const entries = yield* loadModelCatalog({
			foldHome,
			fetchJson: fetch.fetchJson,
			now: Effect.succeed(fixedNow),
		})

		expect(yield* fetch.calls).toBe(1)
		expect(entries).toEqual([cachedEntry])
	}).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, memoryFileSystem({ [cachePath]: cacheFile(fixedNow - 25 * hourMs) })))),
)

it.effect('no cache plus a fetch failure degrades to the baked snapshot', () =>
	Effect.gen(function* () {
		const fetch = yield* recordingFetch(failingOutcome)

		const entries = yield* loadModelCatalog({
			foldHome,
			fetchJson: fetch.fetchJson,
			now: Effect.succeed(fixedNow),
		})

		expect(entries).toBe(bakedModelCatalog)
	}).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, memoryFileSystem({})))),
)

it.effect('FOLD_DISABLE_MODELS_FETCH skips the fetch: stale cache when present, baked otherwise', () =>
	Effect.gen(function* () {
		const env = (name: string): string | undefined => (name === FOLD_DISABLE_MODELS_FETCH ? '1' : undefined)

		const fetchA = yield* recordingFetch(Effect.succeed(fetchedPayload))
		const staleEntries = yield* loadModelCatalog({
			foldHome,
			env,
			fetchJson: fetchA.fetchJson,
			now: Effect.succeed(fixedNow),
		}).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, memoryFileSystem({ [cachePath]: cacheFile(fixedNow - 25 * hourMs) }))))
		expect(staleEntries).toEqual([cachedEntry])
		expect(yield* fetchA.calls).toBe(0)

		const fetchB = yield* recordingFetch(Effect.succeed(fetchedPayload))
		const bakedEntries = yield* loadModelCatalog({
			foldHome,
			env,
			fetchJson: fetchB.fetchJson,
			now: Effect.succeed(fixedNow),
		}).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, memoryFileSystem({}))))
		expect(bakedEntries).toBe(bakedModelCatalog)
		expect(yield* fetchB.calls).toBe(0)
	}),
)

it.effect('corrupt or wrong-version caches read as absent: the fetch runs and repairs the cache', () =>
	Effect.gen(function* () {
		for (const corrupt of [
			'this is not json {{{',
			JSON.stringify({ version: 2, fetchedAt: fixedNow, entries: [] }),
		]) {
			const fs = memoryFileSystem({ [cachePath]: corrupt })
			const fetch = yield* recordingFetch(Effect.succeed(fetchedPayload))

			const entries = yield* loadModelCatalog({
				foldHome,
				fetchJson: fetch.fetchJson,
				now: Effect.succeed(fixedNow),
			}).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, fs)))

			expect(yield* fetch.calls).toBe(1)
			expect(entries[0]?.modelId).toBe('fetched-model')

			const repaired: unknown = JSON.parse(yield* fs.readFileString(cachePath))
			expect(repaired).toEqual({ version: 1, fetchedAt: fixedNow, entries })
		}
	}),
)
