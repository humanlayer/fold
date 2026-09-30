/**
 * This file loads the model catalog for a launch (D15): freshness-at-launch over a local cache of
 * normalized entries, with the baked snapshot as the last resort. The flow is: a fresh cache
 * (`<foldHome>/cache/models-dev.json`, TTL 24h) short-circuits everything; otherwise models.dev is
 * fetched, normalized across ALL providers (the fetched set is the live catalog), and the cache is
 * rewritten; any fetch/decode failure logs a warning and degrades to the stale cache, then the baked
 * catalog. `FOLD_DISABLE_MODELS_FETCH` (env seam) skips the fetch entirely. The loader NEVER fails -
 * a catalog is a capability upgrade, not a launch prerequisite - and there are no background refresh
 * loops (CLI processes are short-lived).
 *
 * Seams follow the fold-agent options convention (AgentFiles/Load.ts): `env` for the disable flag and
 * `now`/`ttlMs` for freshness. The filesystem and the network (`HttpClient`) come from the environment.
 */
import { dirname, join } from 'node:path'

import { ModelCatalogEntry } from '@humanlayer/fold-core'
import { Array as Arr, Clock, Duration, Effect, FileSystem, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import { bakedModelCatalog } from './BakedCatalog'
import { decodeModelsDevModels, ModelsDevDecodeError } from './ModelsDevSchema'
import { modelCatalogEntriesFromModelsDev } from './Normalize'

/** The models.dev endpoint fetched when the local cache is stale. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** Environment variable that, when set (non-empty), disables the models.dev fetch entirely. */
export const FOLD_DISABLE_MODELS_FETCH = 'FOLD_DISABLE_MODELS_FETCH'

/** Default cache freshness window: 24 hours. */
export const defaultCatalogTtlMs = 24 * 60 * 60 * 1000

const fetchTimeoutMillis = 10_000

/** The models.dev fetch failed: network error, HTTP error status, non-JSON body, or timeout. */
export class CatalogFetchError extends Schema.TaggedError<CatalogFetchError>()('CatalogFetchError', {
	message: Schema.String,
}) {}

/**
 * On-disk cache payload: entries are normalized at write time so every launch decodes a small,
 * already-shaped file instead of the 3MB models.dev payload. A wrong version or corrupt file is
 * treated as an absent cache.
 */
export const ModelCatalogCache = Schema.Struct({
	version: Schema.Literal(1),
	fetchedAt: Schema.Number,
	entries: Schema.Array(ModelCatalogEntry),
}).annotate({ identifier: 'ModelCatalogCache' })
export type ModelCatalogCache = typeof ModelCatalogCache.Type

/** Options for {@link loadModelCatalog}. */
export type LoadModelCatalogOptions = {
	/** The fold home directory; the cache lives at `<foldHome>/cache/models-dev.json`. */
	readonly foldHome: string
	/** Environment lookup for {@link FOLD_DISABLE_MODELS_FETCH}. Defaults to reading `process.env`. */
	readonly env?: (name: string) => string | undefined
	/** Clock seam for cache freshness. Defaults to `Clock.currentTimeMillis`. */
	readonly now?: Effect.Effect<number>
	/** Cache freshness window in milliseconds. Defaults to {@link defaultCatalogTtlMs}. */
	readonly ttlMs?: number
}

/** The cache file path for a fold home directory. */
export const modelCatalogCachePath = (foldHome: string): string => join(foldHome, 'cache', 'models-dev.json')

/** GET the models.dev payload as JSON through the ambient `HttpClient`, with a 10s timeout. */
const fetchModelsDevPayload: Effect.Effect<Schema.Json, CatalogFetchError, HttpClient.HttpClient> = HttpClient.get(
	MODELS_DEV_URL,
).pipe(
	Effect.flatMap(HttpClientResponse.filterStatusOk),
	Effect.flatMap((response) => response.json),
	Effect.catchTag('HttpClientError', (error) => Effect.fail(new CatalogFetchError({ message: error.message }))),
	Effect.timeoutOrElse({
		duration: Duration.millis(fetchTimeoutMillis),
		orElse: () =>
			Effect.fail(
				new CatalogFetchError({ message: `GET ${MODELS_DEV_URL} timed out after ${fetchTimeoutMillis}ms` }),
			),
	}),
)

const ModelCatalogCacheText = Schema.fromJsonString(ModelCatalogCache)
const decodeCacheText = Schema.decodeEffect(ModelCatalogCacheText)
const encodeCacheText = Schema.encodeEffect(ModelCatalogCacheText)

/** Read the cache: absent, unreadable, corrupt, or wrong-version files all read as null. */
const readCache = (fs: FileSystem.FileSystem, path: string): Effect.Effect<ModelCatalogCache | null> =>
	Effect.gen(function* () {
		const text = yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed(null)))
		if (text === null) return null

		return yield* decodeCacheText(text).pipe(
			Effect.catch((error) =>
				// Corrupt or wrong-version caches are absent caches: warn, then rebuild from fetch/baked.
				Effect.logWarning(`ignoring corrupt model catalog cache at ${path}: ${error.message}`).pipe(
					Effect.as(null),
				),
			),
		)
	})

/** Write the cache, atomically when the FileSystem supports rename; failures only warn. */
const writeCache = (fs: FileSystem.FileSystem, path: string, cache: ModelCatalogCache): Effect.Effect<void> =>
	Effect.gen(function* () {
		const json = yield* encodeCacheText(cache)
		const tmpPath = `${path}.tmp`

		yield* fs.makeDirectory(dirname(path), { recursive: true })
		yield* fs.writeFileString(tmpPath, json).pipe(
			Effect.andThen(fs.rename(tmpPath, path)),
			// Seams without rename (the in-memory test FileSystem) fall back to a plain write.
			Effect.catch(() =>
				fs.writeFileString(path, json).pipe(Effect.andThen(fs.remove(tmpPath).pipe(Effect.ignore))),
			),
		)
	}).pipe(
		Effect.catch((error) => Effect.logWarning(`could not write model catalog cache at ${path}: ${error.message}`)),
	)

/** Fetch and normalize the live catalog across ALL providers. Zero usable entries is a failure. */
const fetchCatalogEntries: Effect.Effect<
	ReadonlyArray<ModelCatalogEntry>,
	CatalogFetchError | ModelsDevDecodeError,
	HttpClient.HttpClient
> = Effect.gen(function* () {
	const payload = yield* fetchModelsDevPayload
	const models = yield* decodeModelsDevModels(payload)
	const entries = modelCatalogEntriesFromModelsDev(models)
	if (Arr.isReadonlyArrayEmpty(entries)) {
		// An empty catalog would poison the cache for a full TTL; treat it as a decode failure.
		return yield* new ModelsDevDecodeError({ message: 'the models.dev payload contained no usable models' })
	}

	return entries
})

/**
 * Load the model catalog entries for a launch. Never fails: fresh cache, else fetch-and-cache, else
 * stale cache, else the baked snapshot.
 */
export const loadModelCatalog = (
	options: LoadModelCatalogOptions,
): Effect.Effect<ReadonlyArray<ModelCatalogEntry>, never, FileSystem.FileSystem | HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const env = options.env ?? ((name: string) => process.env[name])
		const now = yield* options.now ?? Clock.currentTimeMillis
		const ttlMs = options.ttlMs ?? defaultCatalogTtlMs
		const cachePath = modelCatalogCachePath(options.foldHome)

		const cache = yield* readCache(fs, cachePath)
		if (cache !== null && now - cache.fetchedAt < ttlMs) return cache.entries

		const staleEntries = cache?.entries ?? null
		const fallbackEntries = staleEntries ?? bakedModelCatalog

		const disableFlag = env(FOLD_DISABLE_MODELS_FETCH)
		if (disableFlag !== undefined && disableFlag !== '') return fallbackEntries

		return yield* fetchCatalogEntries.pipe(
			Effect.flatMap((entries) =>
				writeCache(fs, cachePath, { version: 1, fetchedAt: now, entries }).pipe(Effect.as(entries)),
			),
			// Capture the raw failure, then degrade: a missing catalog must never block a launch.
			Effect.catch((error) =>
				Effect.logWarning(
					`could not refresh the model catalog from ${MODELS_DEV_URL}; using ${
						staleEntries === null ? 'the baked snapshot' : 'the stale cache'
					}: ${error.message}`,
				).pipe(Effect.as(fallbackEntries)),
			),
		)
	})
