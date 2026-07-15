/**
 * Focused persistence boundary used by interactive clients to add or update provider profiles.
 * It deliberately does not edit role bindings: an optional model is registered on the provider so
 * it becomes selectable without unexpectedly changing the user's default/profile behavior.
 */
import { dirname } from 'node:path'

import { DEFAULT_CODEX_MODEL_ID } from '@humanlayer/fold-codex'
import { DEFAULT_OPENCODE_MODEL_ID } from '@humanlayer/fold-opencode'
import { DEFAULT_XAI_MODEL_ID } from '@humanlayer/fold-xai'
import { Effect, Schema } from 'effect'

import { fileSystemFor } from '../Fs/DefaultFileSystem'
import type { FoldConfig, ProviderKind } from './ConfigSchema'
import {
	configPathFor,
	loadFoldConfig,
	type ConfigDecodeError,
	type ConfigFileNotFoundError,
	type ConfigParseError,
	type LoadConfigOptions,
} from './Load'

/** Values collected by an interactive provider form. OAuth providers must omit `apiKey`. */
export type ConfigureProviderInput = {
	readonly name: string
	readonly kind: ProviderKind
	readonly baseUrl: string
	readonly apiKey?: string
	readonly model?: string
}

/** The provider form contained an empty or invalid value. */
export class ProviderConfigurationValidationError extends Schema.TaggedErrorClass<ProviderConfigurationValidationError>()(
	'ProviderConfigurationValidationError',
	{ field: Schema.String, message: Schema.String },
) {}

/** The requested provider kind cannot be safely persisted. */
export class ProviderConfigurationKindError extends Schema.TaggedErrorClass<ProviderConfigurationKindError>()(
	'ProviderConfigurationKindError',
	{ kind: Schema.String, message: Schema.String },
) {}

/** The validated config could not be securely persisted. */
export class ProviderConfigurationWriteError extends Schema.TaggedErrorClass<ProviderConfigurationWriteError>()(
	'ProviderConfigurationWriteError',
	{ path: Schema.String, message: Schema.String },
) {}

export type ConfigureProviderError =
	| ConfigFileNotFoundError
	| ConfigParseError
	| ConfigDecodeError
	| ProviderConfigurationValidationError
	| ProviderConfigurationKindError
	| ProviderConfigurationWriteError

const required = (value: string, field: string): Effect.Effect<string, ProviderConfigurationValidationError> => {
	const trimmed = value.trim()
	return trimmed.length === 0
		? Effect.fail(new ProviderConfigurationValidationError({ field, message: `${field} must not be empty` }))
		: Effect.succeed(trimmed)
}

const validBaseUrl = (value: string): Effect.Effect<string, ProviderConfigurationValidationError> =>
	required(value, 'baseUrl').pipe(
		Effect.flatMap((baseUrl) =>
			Effect.try({
				try: () => new URL(baseUrl),
				catch: () =>
					new ProviderConfigurationValidationError({ field: 'baseUrl', message: 'baseUrl must be a URL' }),
			}).pipe(
				Effect.filterOrFail(
					(url) => url.protocol === 'http:' || url.protocol === 'https:',
					() =>
						new ProviderConfigurationValidationError({
							field: 'baseUrl',
							message: 'baseUrl must use http or https',
						}),
				),
				Effect.as(baseUrl),
			),
		),
	)

const writeConfig = (
	config: FoldConfig,
	options: LoadConfigOptions | undefined,
): Effect.Effect<void, ProviderConfigurationWriteError> => {
	const fs = fileSystemFor(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
	const path = configPathFor(options)
	const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`
	const text = `${JSON.stringify(config, null, '\t')}\n`
	const writeDirect = fs.writeFileString(path, text, { mode: 0o600 }).pipe(Effect.andThen(fs.chmod(path, 0o600)))

	return fs.makeDirectory(dirname(path), { recursive: true }).pipe(
		Effect.andThen(fs.writeFileString(temporaryPath, text, { mode: 0o600 })),
		Effect.andThen(fs.chmod(temporaryPath, 0o600)),
		Effect.andThen(fs.rename(temporaryPath, path)),
		Effect.andThen(fs.chmod(path, 0o600)),
		// Some injected/sandbox filesystems do not implement rename. A mode-restricted direct write is
		// still reasonable there; clean up the temporary file on either fallback outcome.
		Effect.catch(() =>
			writeDirect.pipe(Effect.ensuring(fs.remove(temporaryPath).pipe(Effect.catch(() => Effect.void)))),
		),
		Effect.mapError(
			(error) =>
				new ProviderConfigurationWriteError({ path, message: `could not write config: ${error.message}` }),
		),
	)
}

/**
 * Add or replace an Anthropic/OpenAI-compatible connection, preserving every other decoded config
 * field. If `model` is supplied it is appended to `configuredModels`; roles are never modified.
 */
export const configureProvider = (
	input: ConfigureProviderInput,
	options?: LoadConfigOptions,
): Effect.Effect<FoldConfig, ConfigureProviderError> =>
	Effect.gen(function* () {
		const name = yield* required(input.name, 'name')
		const baseUrl = yield* validBaseUrl(input.baseUrl)
		const oauth = input.kind === 'codex' || input.kind === 'opencode' || input.kind === 'xai'
		if (oauth && input.apiKey !== undefined && input.apiKey.trim() !== '')
			return yield* new ProviderConfigurationKindError({
				kind: input.kind,
				message: `${input.kind} credentials are OAuth-managed; an API key must not be supplied`,
			})
		const apiKey = oauth ? undefined : yield* required(input.apiKey ?? '', 'apiKey')
		const defaultModel =
			input.kind === 'codex'
				? DEFAULT_CODEX_MODEL_ID
				: input.kind === 'opencode'
					? DEFAULT_OPENCODE_MODEL_ID
					: input.kind === 'xai'
						? DEFAULT_XAI_MODEL_ID
						: undefined
		const model = input.model === undefined ? defaultModel : yield* required(input.model, 'model')
		const config = yield* loadFoldConfig(options)
		const previousModels = config.providers[name]?.configuredModels ?? []
		const configuredModels = model === undefined ? previousModels : [...new Set([...previousModels, model])]
		const provider = {
			kind: input.kind,
			baseUrl,
			...(apiKey === undefined ? {} : { apiKey }),
			...(configuredModels.length === 0 ? {} : { configuredModels }),
		}
		const updated: FoldConfig = { ...config, providers: { ...config.providers, [name]: provider } }

		yield* writeConfig(updated, options)
		return updated
	}).pipe(Effect.withSpan('config.configure_provider', { attributes: { provider: input.name, kind: input.kind } }))
