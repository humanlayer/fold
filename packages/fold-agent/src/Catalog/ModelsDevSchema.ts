/**
 * This file decodes the subset of the models.dev `api.json` payload fold consumes (D15). The payload
 * is a flat `Record<providerId, Provider>` with `Provider.models: Record<modelId, Model>`; optional
 * model fields are OMITTED KEYS, never null, so every optional is `Schema.optionalKey`. Decoding is
 * deliberately permissive and per-entry: the top level decodes as a record of raw JSON, then each
 * provider and each model decodes individually, so one malformed entry is skipped with a warning
 * instead of killing the whole catalog. Unknown fields are tolerated everywhere (default excess-
 * property behavior), and no value enum (families, modalities, effort names) is hardcoded.
 */
import { Effect, Schema } from 'effect'

/**
 * One `reasoning_options` element, shape-agnostic across the toggle/effort/budget variants: only
 * effort-style options carry `values` (the provider's effort vocabulary; null entries mean "unset").
 */
export const ModelsDevReasoningOption = Schema.Struct({
	type: Schema.String,
	values: Schema.optionalKey(Schema.Array(Schema.NullOr(Schema.String))),
}).annotate({ identifier: 'ModelsDevReasoningOption' })
export type ModelsDevReasoningOption = typeof ModelsDevReasoningOption.Type

/** Token limits of one models.dev model. Fields are optional here; normalization requires context+output. */
export const ModelsDevLimit = Schema.Struct({
	context: Schema.optionalKey(Schema.Finite),
	input: Schema.optionalKey(Schema.Finite),
	output: Schema.optionalKey(Schema.Finite),
}).annotate({ identifier: 'ModelsDevLimit' })
export type ModelsDevLimit = typeof ModelsDevLimit.Type

/** Base USD-per-million-token rates of one models.dev model (tiers/audio/over-200k rates ignored, v1). */
export const ModelsDevCost = Schema.Struct({
	input: Schema.optionalKey(Schema.Finite),
	output: Schema.optionalKey(Schema.Finite),
	cache_read: Schema.optionalKey(Schema.Finite),
	cache_write: Schema.optionalKey(Schema.Finite),
}).annotate({ identifier: 'ModelsDevCost' })
export type ModelsDevCost = typeof ModelsDevCost.Type

/** Input/output modalities of one models.dev model. Values stay open strings (no hardcoded enum). */
export const ModelsDevModalities = Schema.Struct({
	input: Schema.optionalKey(Schema.Array(Schema.String)),
	output: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: 'ModelsDevModalities' })
export type ModelsDevModalities = typeof ModelsDevModalities.Type

/** The subset of one models.dev model fold consumes. */
export const ModelsDevModel = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	reasoning: Schema.Boolean,
	tool_call: Schema.Boolean,
	attachment: Schema.optionalKey(Schema.Boolean),
	modalities: Schema.optionalKey(ModelsDevModalities),
	limit: Schema.optionalKey(ModelsDevLimit),
	cost: Schema.optionalKey(ModelsDevCost),
	reasoning_options: Schema.optionalKey(Schema.Array(ModelsDevReasoningOption)),
}).annotate({ identifier: 'ModelsDevModel' })
export type ModelsDevModel = typeof ModelsDevModel.Type

/** The models.dev payload is unusable: not a provider map (wrong endpoint, HTML error page, ...) or no usable models. */
export class ModelsDevDecodeError extends Schema.TaggedError<ModelsDevDecodeError>()('ModelsDevDecodeError', {
	message: Schema.String,
}) {}

/** One decoded model plus the provider/model ids it lives under in the payload. */
export type ModelsDevNamedModel = {
	readonly providerId: string
	readonly modelId: string
	readonly model: ModelsDevModel
}

/**
 * The top level of `api.json`: a provider map whose entries stay raw JSON so each provider and model
 * decodes on its own. Decode the payload with this schema at the fetch/read boundary.
 */
export const ModelsDevPayload = Schema.Record(Schema.String, Schema.Json).annotate({ identifier: 'ModelsDevPayload' })
export type ModelsDevPayload = typeof ModelsDevPayload.Type

const decodeProviderModels = Schema.decodeUnknownEffect(
	Schema.Struct({ models: Schema.Record(Schema.String, Schema.Json) }),
)
const decodeModel = Schema.decodeUnknownEffect(ModelsDevModel)

/**
 * Decode a models.dev provider map into named models, permissively: providers or models that fail to
 * decode are skipped with a warning while the rest of the catalog survives.
 */
export const decodeModelsDevModels = (providers: ModelsDevPayload): Effect.Effect<ReadonlyArray<ModelsDevNamedModel>> =>
	Effect.gen(function* () {
		const models: Array<ModelsDevNamedModel> = []
		for (const [providerId, rawProvider] of Object.entries(providers)) {
			const provider = yield* decodeProviderModels(rawProvider).pipe(
				Effect.catchTag('SchemaError', (error) =>
					Effect.logWarning(`skipping models.dev provider "${providerId}": ${error.message}`).pipe(
						Effect.as(null),
					),
				),
			)
			if (provider === null) continue

			for (const [modelId, rawModel] of Object.entries(provider.models)) {
				const model = yield* decodeModel(rawModel).pipe(
					Effect.catchTag('SchemaError', (error) =>
						Effect.logWarning(
							`skipping models.dev model "${providerId}/${modelId}": ${error.message}`,
						).pipe(Effect.as(null)),
					),
				)
				if (model === null) continue

				models.push({ providerId, modelId, model })
			}
		}

		return models
	})
