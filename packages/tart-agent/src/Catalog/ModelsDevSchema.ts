/**
 * This file decodes the subset of the models.dev `api.json` payload tart consumes (D15). The payload
 * is a flat `Record<providerId, Provider>` with `Provider.models: Record<modelId, Model>`; optional
 * model fields are OMITTED KEYS, never null, so every optional is `Schema.optionalKey`. Decoding is
 * deliberately permissive and per-entry: the top level decodes as records of unknown, then each
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
	context: Schema.optionalKey(Schema.Number),
	input: Schema.optionalKey(Schema.Number),
	output: Schema.optionalKey(Schema.Number),
}).annotate({ identifier: 'ModelsDevLimit' })
export type ModelsDevLimit = typeof ModelsDevLimit.Type

/** Base USD-per-million-token rates of one models.dev model (tiers/audio/over-200k rates ignored, v1). */
export const ModelsDevCost = Schema.Struct({
	input: Schema.optionalKey(Schema.Number),
	output: Schema.optionalKey(Schema.Number),
	cache_read: Schema.optionalKey(Schema.Number),
	cache_write: Schema.optionalKey(Schema.Number),
}).annotate({ identifier: 'ModelsDevCost' })
export type ModelsDevCost = typeof ModelsDevCost.Type

/** Input/output modalities of one models.dev model. Values stay open strings (no hardcoded enum). */
export const ModelsDevModalities = Schema.Struct({
	input: Schema.optionalKey(Schema.Array(Schema.String)),
	output: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: 'ModelsDevModalities' })
export type ModelsDevModalities = typeof ModelsDevModalities.Type

/** The subset of one models.dev model tart consumes. */
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

/** The models.dev payload is not a provider map at all (wrong endpoint, HTML error page, ...). */
export class ModelsDevDecodeError extends Schema.TaggedErrorClass<ModelsDevDecodeError>()('ModelsDevDecodeError', {
	message: Schema.String,
}) {}

/** One decoded model plus the provider/model ids it lives under in the payload. */
export type ModelsDevNamedModel = {
	readonly providerId: string
	readonly modelId: string
	readonly model: ModelsDevModel
}

const decodeProviderMap = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))
const decodeProviderModels = Schema.decodeUnknownEffect(
	Schema.Struct({ models: Schema.Record(Schema.String, Schema.Unknown) }),
)
const decodeModel = Schema.decodeUnknownEffect(ModelsDevModel)

/**
 * Decode a models.dev `api.json` payload into named models, permissively: providers or models that
 * fail to decode are skipped with a warning while the rest of the catalog survives. Fails only when
 * the top level is not a provider map at all.
 */
export const decodeModelsDevModels = (
	data: unknown,
): Effect.Effect<ReadonlyArray<ModelsDevNamedModel>, ModelsDevDecodeError> =>
	Effect.gen(function* () {
		const providers = yield* decodeProviderMap(data).pipe(
			Effect.mapError(
				(error) =>
					new ModelsDevDecodeError({ message: `models.dev payload is not a provider map: ${error.message}` }),
			),
		)

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
