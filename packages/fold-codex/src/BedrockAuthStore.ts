/** File-backed configuration for the sibling `codex_bedrock` auth entry. */
import { dirname } from 'node:path'

import { Effect, FileSystem, Option, Schema } from 'effect'

import { defaultAuthStorePath } from './AuthStore'

/** Durable, non-secret AWS profile selection used by Fold Codex. */
export class CodexBedrockAuthData extends Schema.Class<CodexBedrockAuthData>('fold/CodexBedrockAuthData')({
	type: Schema.Literal('aws-profile'),
	active: Schema.optional(Schema.Boolean),
	profile: Schema.optional(Schema.String),
	region: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	baseUrl: Schema.optional(Schema.String),
}) {}

/** Persistence or decoding failure for the Bedrock configuration entry. */
export class CodexBedrockAuthStoreError extends Schema.TaggedError<CodexBedrockAuthStoreError>()(
	'CodexBedrockAuthStoreError',
	{
		reason: Schema.Literals(['InvalidDocument', 'InvalidEntry', 'ReadFailed', 'WriteFailed']),
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

export type CodexBedrockAuthStore = {
	readonly path: string
	readonly load: Effect.Effect<Option.Option<CodexBedrockAuthData>, CodexBedrockAuthStoreError>
	readonly save: (
		configuration: CodexBedrockAuthData,
	) => Effect.Effect<CodexBedrockAuthData, CodexBedrockAuthStoreError>
	readonly clear: Effect.Effect<void, CodexBedrockAuthStoreError>
}

export type MakeCodexBedrockAuthStoreOptions = {
	readonly path?: string
}

const AuthDocument = Schema.Record(Schema.String, Schema.Unknown)
const decodeDocument = Schema.decodeUnknownOption(Schema.fromJsonString(AuthDocument))
const decodeConfiguration = Schema.decodeUnknownOption(CodexBedrockAuthData)

const encodeConfiguration = (configuration: CodexBedrockAuthData): Record<string, unknown> => {
	const encoded: Record<string, unknown> = { type: configuration.type }
	if (configuration.active !== undefined) encoded['active'] = configuration.active
	if (configuration.profile !== undefined) encoded['profile'] = configuration.profile
	if (configuration.region !== undefined) encoded['region'] = configuration.region
	if (configuration.model !== undefined) encoded['model'] = configuration.model
	if (configuration.baseUrl !== undefined) encoded['baseUrl'] = configuration.baseUrl
	return encoded
}

/** Build a store targeting `codex_bedrock` in the same auth document as Codex OAuth. */
export const makeCodexBedrockAuthStore = (
	options?: MakeCodexBedrockAuthStoreOptions,
): Effect.Effect<CodexBedrockAuthStore, never, FileSystem.FileSystem> =>
	Effect.map(FileSystem.FileSystem, (fs) => {
		const path = options?.path ?? defaultAuthStorePath()

		const readDocument: Effect.Effect<Record<string, unknown>, CodexBedrockAuthStoreError> = fs
			.readFileString(path)
			.pipe(
				Effect.map<string, string | null>((content) => content),
				Effect.catchReasons('PlatformError', { NotFound: () => Effect.succeed(null) }),
				Effect.mapError(
					(cause) =>
						new CodexBedrockAuthStoreError({
							reason: 'ReadFailed',
							message: `Failed to read the auth store at ${path}`,
							cause,
						}),
				),
				Effect.flatMap((content) => {
					if (content === null) return Effect.succeed<Record<string, unknown>>({})
					const document = decodeDocument(content)
					return Option.isSome(document)
						? Effect.succeed(document.value)
						: Effect.fail(
								new CodexBedrockAuthStoreError({
									reason: 'InvalidDocument',
									message: `Auth store ${path} is not a valid JSON object`,
								}),
							)
				}),
			)

		const writeDocument = (document: Record<string, unknown>): Effect.Effect<void, CodexBedrockAuthStoreError> =>
			Effect.gen(function* () {
				yield* fs.makeDirectory(dirname(path), { recursive: true })
				yield* fs.writeFileString(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
				yield* fs.chmod(path, 0o600)
			}).pipe(
				Effect.mapError(
					(cause) =>
						new CodexBedrockAuthStoreError({
							reason: 'WriteFailed',
							message: `Failed to write the auth store at ${path}`,
							cause,
						}),
				),
			)

		const load = Effect.gen(function* () {
			const document = yield* readDocument
			const entry = document['codex_bedrock']
			if (entry === undefined) return Option.none<CodexBedrockAuthData>()
			const configuration = decodeConfiguration(entry)
			if (Option.isNone(configuration)) {
				return yield* new CodexBedrockAuthStoreError({
					reason: 'InvalidEntry',
					message: `Invalid "codex_bedrock" entry in ${path}`,
				})
			}
			return configuration
		}).pipe(Effect.withSpan('fold.codexBedrockAuthStore.load'))

		const save = (configuration: CodexBedrockAuthData) =>
			Effect.gen(function* () {
				const document = yield* readDocument
				yield* writeDocument({ ...document, codex_bedrock: encodeConfiguration(configuration) })
				return configuration
			}).pipe(Effect.withSpan('fold.codexBedrockAuthStore.save'))

		const clear = Effect.gen(function* () {
			const document = yield* readDocument
			if (document['codex_bedrock'] === undefined) return
			const { codex_bedrock: _removed, ...rest } = document
			yield* writeDocument(rest)
		}).pipe(Effect.withSpan('fold.codexBedrockAuthStore.clear'))

		return { path, load, save, clear }
	})
