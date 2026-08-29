import type { ModelCatalogEntry } from '@humanlayer/fold-core'
import { Schema } from 'effect'

/** Model IDs verified for xAI subscription-backed OAuth sessions. */
export const XaiFrontierModelId = Schema.Literals(['grok-4.5', 'grok-4.6'])
export type XaiFrontierModelId = typeof XaiFrontierModelId.Type

/** One model exposed to embedding hosts for validation and selection controls. */
export const XaiFrontierModel = Schema.Struct({
	modelId: XaiFrontierModelId,
	label: Schema.NonEmptyString,
})
export type XaiFrontierModel = typeof XaiFrontierModel.Type

/** Frontier Grok models supported by Fold's xAI OAuth transport. */
export const XAI_FRONTIER_MODELS = [
	{ modelId: 'grok-4.5', label: 'Grok 4.5' },
	{ modelId: 'grok-4.6', label: 'Grok 4.6' },
] as const satisfies ReadonlyArray<XaiFrontierModel>

/**
 * Offline model metadata for the xAI OAuth models Fold can launch. This supplements the generated
 * models.dev snapshot so embedding hosts can install the correct context limit without fetching a
 * live catalog before a session starts.
 */
export const XAI_FRONTIER_MODEL_CATALOG = [
	{
		providerId: 'xai',
		modelId: 'grok-4.5',
		name: 'Grok 4.5',
		contextWindow: 500_000,
		maxInputTokens: null,
		maxOutputTokens: 500_000,
		reasoning: true,
		reasoningEfforts: ['low', 'medium', 'high'],
		vision: true,
		toolCall: true,
		pricing: { inputPerMTokens: 2, outputPerMTokens: 6, cacheReadPerMTokens: 0.3, cacheWritePerMTokens: null },
	},
	{
		providerId: 'xai',
		modelId: 'grok-4.6',
		name: 'Grok 4.6',
		contextWindow: 500_000,
		maxInputTokens: null,
		maxOutputTokens: 500_000,
		reasoning: true,
		reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
		vision: true,
		toolCall: true,
		pricing: { inputPerMTokens: 2, outputPerMTokens: 6, cacheReadPerMTokens: 0.5, cacheWritePerMTokens: null },
	},
] as const satisfies ReadonlyArray<ModelCatalogEntry>

/** The model selected when an embedding host does not provide one. */
export const DEFAULT_XAI_MODEL_ID: XaiFrontierModelId = 'grok-4.6'
