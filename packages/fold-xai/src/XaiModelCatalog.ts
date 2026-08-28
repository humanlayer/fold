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

/** The model selected when an embedding host does not provide one. */
export const DEFAULT_XAI_MODEL_ID: XaiFrontierModelId = 'grok-4.6'
