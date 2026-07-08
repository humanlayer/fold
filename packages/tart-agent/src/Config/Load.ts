/**
 * This file loads and decodes `~/.tart/config.jsonc` (D25). JSONC is JSON with `//` and block comments
 * and trailing commas; {@link stripJsonc} removes both (string-aware, so `//` or a comma inside a JSON
 * string is preserved) and the result is parsed as JSON, then decoded through the `TartConfig` schema
 * with `onExcessProperty: "error"` so a typo'd top-level key is a decode failure, not a silent drop.
 *
 * Failures are typed and caller-actionable: `ConfigFileNotFoundError` (run `configInit`),
 * `ConfigParseError` (JSONC syntax), and `ConfigDecodeError` (shape/reference validation, carrying the
 * schema's formatted message). The filesystem seam matches the rest of tart-agent (`fileSystem`
 * override for hermetic tests; the Node platform filesystem by default).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Effect, Schema } from 'effect'

import { fileSystemFor, type FsToolOptions } from '../Fs/DefaultFileSystem'
import { TartConfig } from './ConfigSchema'

/** The config file could not be found at the resolved path. */
export class ConfigFileNotFoundError extends Schema.TaggedErrorClass<ConfigFileNotFoundError>()(
	'ConfigFileNotFoundError',
	{ path: Schema.String },
) {}

/** The config file is not valid JSONC (comment/brace/JSON syntax error). */
export class ConfigParseError extends Schema.TaggedErrorClass<ConfigParseError>()('ConfigParseError', {
	path: Schema.NullOr(Schema.String),
	message: Schema.String,
}) {}

/** The config parsed as JSON but does not match the `TartConfig` schema. */
export class ConfigDecodeError extends Schema.TaggedErrorClass<ConfigDecodeError>()('ConfigDecodeError', {
	path: Schema.NullOr(Schema.String),
	message: Schema.String,
}) {}

/** Options for the config loaders. */
export type LoadConfigOptions = {
	/** Explicit config file path. Defaults to `<tartHome>/config.jsonc`. */
	readonly path?: string
	/** The tart home directory. Defaults to `~/.tart`. */
	readonly tartHome?: string
	/** FileSystem override for hermetic tests. Defaults to the Node platform filesystem. */
	readonly fileSystem?: FsToolOptions['fileSystem']
}

/** The tart home directory: `~/.tart`. */
export const defaultTartHome = (): string => join(homedir(), '.tart')

/** The config file path for a home directory. */
export const defaultConfigPath = (tartHome?: string): string => join(tartHome ?? defaultTartHome(), 'config.jsonc')

/** Resolve the config path from loader options. */
export const configPathFor = (options?: LoadConfigOptions): string =>
	options?.path ?? defaultConfigPath(options?.tartHome)

const isWhitespace = (char: string): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\r'

/**
 * Strip JSONC comments and trailing commas, string-aware. `//` line comments, `/* *\/` block comments,
 * and a comma immediately before a closing `}`/`]` are removed; anything inside a `"..."` string
 * (including escaped quotes) is preserved verbatim. The output is plain JSON for `JSON.parse`.
 */
export const stripJsonc = (input: string): string => {
	const out: Array<string> = []
	const length = input.length
	let index = 0
	let inString = false

	// Remove a comma that (ignoring whitespace) immediately precedes the `}`/`]` about to be emitted.
	const dropPrecedingTrailingComma = (): void => {
		let cursor = out.length - 1
		while (cursor >= 0 && isWhitespace(out[cursor] ?? '')) cursor--
		if (cursor >= 0 && out[cursor] === ',') out.splice(cursor, 1)
	}

	while (index < length) {
		const char = input.charAt(index)

		if (inString) {
			out.push(char)
			if (char === '\\' && index + 1 < length) {
				out.push(input.charAt(index + 1))
				index += 2
				continue
			}
			if (char === '"') inString = false
			index++
			continue
		}

		if (char === '"') {
			inString = true
			out.push(char)
			index++
			continue
		}

		if (char === '/' && input.charAt(index + 1) === '/') {
			index += 2
			while (index < length && input.charAt(index) !== '\n') index++
			continue
		}

		if (char === '/' && input.charAt(index + 1) === '*') {
			index += 2
			while (index < length && !(input.charAt(index) === '*' && input.charAt(index + 1) === '/')) index++
			index += 2
			continue
		}

		if (char === '}' || char === ']') {
			dropPrecedingTrailingComma()
			out.push(char)
			index++
			continue
		}

		out.push(char)
		index++
	}

	return out.join('')
}

const decodeConfig = Schema.decodeUnknownEffect(TartConfig, { onExcessProperty: 'error' })

/** Parse and decode JSONC text into a {@link TartConfig}. Pure: no filesystem access. */
export const parseTartConfig = (
	text: string,
	options?: { readonly path?: string },
): Effect.Effect<TartConfig, ConfigParseError | ConfigDecodeError> =>
	Effect.gen(function* () {
		const path = options?.path ?? null
		const parsed = yield* Effect.try({
			try: (): unknown => JSON.parse(stripJsonc(text)),
			catch: (cause) =>
				new ConfigParseError({ path, message: cause instanceof Error ? cause.message : String(cause) }),
		})

		return yield* decodeConfig(parsed).pipe(
			Effect.mapError((error) => new ConfigDecodeError({ path, message: error.message })),
		)
	})

/**
 * Load and decode the config from disk. Fails with {@link ConfigFileNotFoundError} when the file is
 * absent (the caller can fall back to an explicit model, or prompt the user to run `configInit`).
 */
export const loadTartConfig = (
	options?: LoadConfigOptions,
): Effect.Effect<TartConfig, ConfigFileNotFoundError | ConfigParseError | ConfigDecodeError> =>
	Effect.gen(function* () {
		const fs = fileSystemFor(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
		const path = configPathFor(options)

		const exists = yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)))
		if (!exists) return yield* new ConfigFileNotFoundError({ path })

		const text = yield* fs.readFileString(path).pipe(Effect.orDie)
		return yield* parseTartConfig(text, { path })
	})

/**
 * Like {@link loadTartConfig} but returns `null` when the file is absent (parse/decode errors still
 * fail). Convenient for launch paths that accept an explicit model when no config exists.
 */
export const loadTartConfigOrNull = (
	options?: LoadConfigOptions,
): Effect.Effect<TartConfig | null, ConfigParseError | ConfigDecodeError> =>
	loadTartConfig(options).pipe(Effect.catchTag('ConfigFileNotFoundError', () => Effect.succeed(null)))
