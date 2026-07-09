/**
 * This file defines the ModelCatalog contract (D15): schema-first entries describing one model's
 * limits, reasoning support, vision support, and pricing, plus the lookup service the runtime
 * consults with the domain type callers already hold - an `ActiveModel`. Core owns only the contract
 * and the matching logic; `tart-agent` ships the models.dev-backed data source and hosts install the
 * entries session-wide through `startSession`/`resumeSession`.
 *
 * The service is a `Context.Reference` whose default is the empty catalog (`lookup` always null), so
 * low-level composition roots never mention it and every consumer degrades gracefully: compaction
 * falls back to its interim pattern table, cost rendering falls back to `--`.
 */
import { Context, Effect, Schema } from 'effect'

import type { ActiveModel } from '../EventLog/Schemas'

/** Model pricing in USD per 1,000,000 tokens. Null rates mean the provider publishes no such rate. */
export const ModelPricing = Schema.Struct({
	inputPerMTokens: Schema.Number,
	outputPerMTokens: Schema.Number,
	cacheReadPerMTokens: Schema.NullOr(Schema.Number),
	cacheWritePerMTokens: Schema.NullOr(Schema.Number),
}).annotate({ identifier: 'ModelPricing' })
export type ModelPricing = typeof ModelPricing.Type

/**
 * One catalog row: the limits, capabilities, and pricing of one model under one catalog provider id
 * (models.dev vocabulary: `anthropic`, `openai`, ...). `reasoningEfforts` null means the model has no
 * effort-list constraint (toggle/budget-style reasoning, or none); `pricing` null means unknown.
 */
export const ModelCatalogEntry = Schema.Struct({
	providerId: Schema.String,
	modelId: Schema.String,
	name: Schema.NullOr(Schema.String),
	contextWindow: Schema.Number,
	maxInputTokens: Schema.NullOr(Schema.Number),
	maxOutputTokens: Schema.Number,
	reasoning: Schema.Boolean,
	reasoningEfforts: Schema.NullOr(Schema.Array(Schema.String)),
	vision: Schema.Boolean,
	toolCall: Schema.Boolean,
	pricing: Schema.NullOr(ModelPricing),
}).annotate({ identifier: 'ModelCatalogEntry' })
export type ModelCatalogEntry = typeof ModelCatalogEntry.Type

/**
 * Catalog lookup consulted by the runtime (compaction windows) and hosts (cost, pickers). Takes the
 * `ActiveModel` callers already hold; returns the matching entry or null when the catalog does not
 * know the model - consumers fall back to their interim defaults on null.
 */
export type ModelCatalogService = {
	readonly lookup: (model: ActiveModel) => Effect.Effect<ModelCatalogEntry | null>
}

/**
 * Catalog provider ids an active model may match, most specific first. The catalog speaks models.dev
 * vocabulary, so provider KINDS map onto catalog provider ids: anthropic-kind models live under
 * `anthropic`, the codex backend serves openai models, and openai-compatible endpoints usually proxy
 * `openai` models but may be a real catalog provider themselves (the configured profile id).
 */
const candidateProviderIds = (model: ActiveModel): ReadonlyArray<string> => {
	switch (model.providerKind) {
		case 'anthropic':
			return ['anthropic']
		case 'codex':
			return ['openai']
		case 'openai-compatible':
			return model.providerId === 'openai' ? ['openai'] : [model.providerId, 'openai']
	}
}

/** Deterministic preference for bare-model-id matches: anthropic, then openai, then first-seen. */
const bareMatchPriority = (providerId: string): number =>
	providerId === 'anthropic' ? 2 : providerId === 'openai' ? 1 : 0

type CatalogIndex = {
	readonly byProvider: ReadonlyMap<string, ReadonlyMap<string, ModelCatalogEntry>>
	readonly byModelId: ReadonlyMap<string, ModelCatalogEntry>
}

const indexCatalogEntries = (entries: ReadonlyArray<ModelCatalogEntry>): CatalogIndex => {
	const byProvider = new Map<string, Map<string, ModelCatalogEntry>>()
	const byModelId = new Map<string, ModelCatalogEntry>()

	for (const entry of entries) {
		const models = byProvider.get(entry.providerId) ?? new Map<string, ModelCatalogEntry>()
		if (!byProvider.has(entry.providerId)) byProvider.set(entry.providerId, models)
		if (!models.has(entry.modelId)) models.set(entry.modelId, entry)

		const current = byModelId.get(entry.modelId)
		if (current === undefined || bareMatchPriority(entry.providerId) > bareMatchPriority(current.providerId)) {
			byModelId.set(entry.modelId, entry)
		}
	}

	return { byProvider, byModelId }
}

const lookupInIndex = (index: CatalogIndex, model: ActiveModel): ModelCatalogEntry | null => {
	for (const providerId of candidateProviderIds(model)) {
		const exact = index.byProvider.get(providerId)?.get(model.modelId)
		if (exact !== undefined) return exact
	}

	return index.byModelId.get(model.modelId) ?? null
}

/**
 * Pure catalog lookup over a plain entry list, for synchronous consumers (the CLI renderer). An
 * exact (candidate provider id, model id) hit wins; otherwise the bare model id matches with the
 * anthropic-then-openai-then-first-seen preference; otherwise null. The {@link ModelCatalogService}
 * built by {@link modelCatalogFromEntries} wraps exactly this matching logic.
 */
export const lookupCatalogEntry = (
	entries: ReadonlyArray<ModelCatalogEntry>,
	model: ActiveModel,
): ModelCatalogEntry | null => lookupInIndex(indexCatalogEntries(entries), model)

/** Build a ModelCatalog service over a fixed entry list, indexed once at construction. */
export const modelCatalogFromEntries = (entries: ReadonlyArray<ModelCatalogEntry>): ModelCatalogService => {
	const index = indexCatalogEntries(entries)

	return { lookup: (model) => Effect.sync(() => lookupInIndex(index, model)) }
}

/** The default catalog: knows no models, so every consumer uses its fallback. */
export const emptyModelCatalog: ModelCatalogService = {
	lookup: () => Effect.succeed(null),
}

/**
 * ModelCatalog service key with the empty-catalog default. Sessions started with `catalog: [...]`
 * provide a data-backed service; everything else - including low-level layer graphs that never
 * mention the catalog - resolves the empty default with zero R-type footprint.
 */
export const ModelCatalog: Context.Reference<ModelCatalogService> = Context.Reference('tart/ModelCatalog', {
	defaultValue: () => emptyModelCatalog,
})
