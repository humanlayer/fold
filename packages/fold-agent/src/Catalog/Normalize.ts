/**
 * This file normalizes decoded models.dev models into core `ModelCatalogEntry` rows (D15). Pure
 * functional core: no I/O, no logging - the loader and the bake script own orchestration. Models
 * without a usable `limit` (context + output) normalize to null and are dropped; pricing keeps only
 * the base per-million-token rates (tiers/audio/over-200k are v1 non-goals); `reasoningEfforts` is
 * the first effort-style `reasoning_options` element's non-null values, or null when the model has
 * no effort-list constraint (toggle/budget-style reasoning, or no reasoning at all).
 */
import type { ModelCatalogEntry, ModelPricing } from '@humanlayer/fold-core'

import type { ModelsDevModel, ModelsDevNamedModel } from './ModelsDevSchema'

const pricingFrom = (model: ModelsDevModel): ModelPricing | null => {
	const cost = model.cost
	if (cost === undefined || cost.input === undefined || cost.output === undefined) return null

	return {
		inputPerMTokens: cost.input,
		outputPerMTokens: cost.output,
		cacheReadPerMTokens: cost.cache_read ?? null,
		cacheWritePerMTokens: cost.cache_write ?? null,
	}
}

const reasoningEffortsFrom = (model: ModelsDevModel): ReadonlyArray<string> | null => {
	const effortOption = (model.reasoning_options ?? []).find((option) => option.type === 'effort')
	if (effortOption?.values === undefined) return null

	const efforts = effortOption.values.filter((value): value is string => value !== null)

	return efforts.length === 0 ? null : efforts
}

/**
 * Normalize one named models.dev model into a catalog entry, or null when the model lacks a usable
 * `limit` (no context window or no output cap means nothing downstream can budget against it).
 */
export const modelCatalogEntryFromModelsDev = (input: ModelsDevNamedModel): ModelCatalogEntry | null => {
	const { model } = input
	const limit = model.limit
	if (limit === undefined || limit.context === undefined || limit.output === undefined) return null

	return {
		providerId: input.providerId,
		modelId: input.modelId,
		name: model.name ?? null,
		contextWindow: limit.context,
		maxInputTokens: limit.input ?? null,
		maxOutputTokens: limit.output,
		reasoning: model.reasoning,
		reasoningEfforts: reasoningEffortsFrom(model),
		vision: (model.modalities?.input ?? []).includes('image'),
		toolCall: model.tool_call,
		pricing: pricingFrom(model),
	}
}

/** Normalize a decoded models.dev model list, dropping models without a usable limit. */
export const modelCatalogEntriesFromModelsDev = (
	models: ReadonlyArray<ModelsDevNamedModel>,
): ReadonlyArray<ModelCatalogEntry> =>
	models.flatMap((named) => {
		const entry = modelCatalogEntryFromModelsDev(named)

		return entry === null ? [] : [entry]
	})
