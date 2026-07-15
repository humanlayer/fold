/**
 * This file defines the typed ToolState API that tools and hooks use for durable key-value state.
 * ToolRuntime provides a concrete ToolState service around each handler, and tool authors consume
 * defineToolState to declare schema-checked namespaces without depending on EventLog directly.
 */
import { Context, Effect, Schema } from 'effect'

type ToolStateKeySchemas = Readonly<Record<string, Schema.ConstraintDecoder<unknown>>>
type ToolStateKey<Keys extends ToolStateKeySchemas> = Extract<keyof Keys, string>
type ToolStateValue<Keys extends ToolStateKeySchemas, Key extends ToolStateKey<Keys>> = Keys[Key]['Type']

/**
 * Durable tool state access scoped to one agent and one tool call. The namespace is supplied per
 * operation - typically by a {@link defineToolState} definition passing its declared namespace - so the
 * declaration is the single source of truth for which namespace a read or write targets.
 */
export type ToolStateService = {
	/** Read a raw state value by namespace and key, returning null when no value has been written. */
	readonly get: (namespace: string, key: string) => Effect.Effect<unknown>
	/** Write or clear a raw state value by namespace and key. */
	readonly set: (namespace: string, key: string, value: unknown) => Effect.Effect<void>
}

/** Typed ToolState namespace definition for a tool or hook. */
export type ToolStateDefinition<Keys extends ToolStateKeySchemas> = {
	readonly namespace: string
	readonly keys: Keys
	/** Read and decode one value from this state namespace. */
	readonly get: <Key extends ToolStateKey<Keys>>(
		key: Key,
	) => Effect.Effect<ToolStateValue<Keys, Key> | null, never, ToolState>
	/** Validate and write one value into this state namespace. */
	readonly set: <Key extends ToolStateKey<Keys>>(
		key: Key,
		value: ToolStateValue<Keys, Key> | null,
	) => Effect.Effect<void, never, ToolState>
}

/** Ambient durable tool state service. */
export class ToolState extends Context.Service<ToolState, ToolStateService>()('fold/ToolState') {}

/** Define a typed durable state namespace for a tool or hook. */
export const defineToolState = <const Keys extends ToolStateKeySchemas>(input: {
	readonly namespace: string
	readonly keys: Keys
}): ToolStateDefinition<Keys> => {
	/** Return the declared schema for one known key in this namespace. */
	const schemaFor = <Key extends ToolStateKey<Keys>>(key: Key): Keys[Key] => {
		const schema = input.keys[key]

		// `Key` is constrained to the declared keys, so absence means the definition itself is broken.
		if (schema === undefined) {
			throw new Error(`ToolState namespace "${input.namespace}" declares no schema for key "${key}"`)
		}

		return schema
	}

	/** Decode one candidate value with the schema declared for the requested key. */
	const decodeValue = <Key extends ToolStateKey<Keys>>(
		key: Key,
		value: unknown,
	): Effect.Effect<ToolStateValue<Keys, Key>> => Effect.sync(() => Schema.decodeUnknownSync(schemaFor(key))(value))

	return {
		namespace: input.namespace,
		keys: input.keys,

		/** Read and decode one key through the ambient ToolState service in this definition's namespace. */
		get: (key) =>
			ToolState.pipe(
				Effect.flatMap((state) =>
					state.get(input.namespace, key).pipe(
						Effect.flatMap((value) => {
							if (value === null) return Effect.succeed(null)

							return decodeValue(key, value)
						}),
					),
				),
			),

		/** Validate and write one key through the ambient ToolState service in this definition's namespace. */
		set: (key, value) =>
			ToolState.pipe(
				Effect.flatMap((state) => {
					if (value === null) return state.set(input.namespace, key, null)

					return decodeValue(key, value).pipe(
						Effect.flatMap((decoded) => state.set(input.namespace, key, decoded)),
					)
				}),
			),
	}
}
