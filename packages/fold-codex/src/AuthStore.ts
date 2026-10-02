/**
 * File-backed Codex credential store: one provider-keyed JSON document (default `~/.fold/auth.json`)
 * holding OAuth tokens only (D23). Field names are agentlayer-compatible (`access`/`refresh`/`expires`/
 * `accountId`), so existing entries copy across verbatim. The document may hold other providers'
 * entries, so it decodes as provider-keyed JSON and only our entry decodes as a token. A missing file is
 * an empty document. `load` degrades to "no credentials" (with a logged warning) on an unreadable or
 * corrupt document or a bad codex entry; `save`/`clear` fail on an unreadable or corrupt document rather
 * than clobber it. Writes merge over the existing document and force `0600` permissions.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { Context, Effect, FileSystem, Layer, Option, Schema } from 'effect'

/** Milliseconds before nominal expiry a token is already treated as expired (clanka parity). */
export const TOKEN_EXPIRY_BUFFER_MS = 30_000

/** Default location of the fold auth store. */
export const defaultAuthStorePath = (): string => join(homedir(), '.fold', 'auth.json')

/** One stored Codex OAuth credential. `expires` is epoch milliseconds for the access token. */
export class CodexTokenData extends Schema.Class<CodexTokenData>('fold/CodexTokenData')({
	type: Schema.Literal('oauth'),
	access: Schema.String,
	refresh: Schema.String,
	expires: Schema.Finite,
	accountId: Schema.optional(Schema.String),
}) {
	/** True when the token is expired - or within the safety buffer of expiring - at `nowMs`. */
	isExpired(nowMs: number): boolean {
		return this.expires < nowMs + TOKEN_EXPIRY_BUFFER_MS
	}
}

/** Auth store failure: the document could not be read, is not provider-keyed JSON, or could not be written. */
export class CodexAuthStoreError extends Schema.TaggedError<CodexAuthStoreError>()('CodexAuthStoreError', {
	reason: Schema.Literals(['ReadFailed', 'InvalidDocument', 'WriteFailed']),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

/** The credential store one CodexAuth instance persists through. */
export type CodexAuthStoreService = {
	/** Absolute path of the backing JSON document (used in error messages and guidance). */
	readonly path: string
	readonly load: Effect.Effect<Option.Option<CodexTokenData>>
	readonly save: (token: CodexTokenData) => Effect.Effect<CodexTokenData, CodexAuthStoreError>
	readonly clear: Effect.Effect<void, CodexAuthStoreError>
}

/** The credential store CodexAuth persists through; {@link layerCodexAuthStore} provides the file-backed one. */
export class CodexAuthStore extends Context.Service<CodexAuthStore, CodexAuthStoreService>()('fold/CodexAuthStore') {}

/** Options for {@link layerCodexAuthStore}. */
export type CodexAuthStoreOptions = {
	/** Path of the auth document. Defaults to `~/.fold/auth.json`. */
	readonly path?: string
	/** Key of this provider's entry in the document. Defaults to `codex`. */
	readonly providerId?: string
}

/** The auth document: JSON entries keyed by provider id. Entries other than ours are preserved verbatim. */
export const CodexAuthDocument = Schema.Record(Schema.String, Schema.Json)
export type CodexAuthDocument = typeof CodexAuthDocument.Type

const emptyDocument: CodexAuthDocument = {}

const decodeDocument = Schema.decodeEffect(Schema.fromJsonString(CodexAuthDocument))

const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(CodexAuthDocument, { space: 2 }))

/** Our entry's JSON codec: decodes a document value into a token and encodes a token back to JSON. */
const CodexTokenEntry = Schema.toCodecJson(CodexTokenData)

const decodeTokenEntry = Schema.decodeOption(CodexTokenEntry)

const encodeTokenEntry = Schema.encodeEffect(CodexTokenEntry)

/** A file-backed Codex credential store. */
export const layerCodexAuthStore = (
	options?: CodexAuthStoreOptions,
): Layer.Layer<CodexAuthStore, never, FileSystem.FileSystem> =>
	Layer.effect(
		CodexAuthStore,
		Effect.map(FileSystem.FileSystem, (fs): CodexAuthStoreService => {
			const path = options?.path ?? defaultAuthStorePath()
			const providerId = options?.providerId ?? 'codex'

			// A missing document is simply "no credentials stored yet"; any other read failure is real.
			const readDocument: Effect.Effect<CodexAuthDocument, CodexAuthStoreError> = fs.readFileString(path).pipe(
				Effect.asSome,
				Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(Option.none<string>())),
				Effect.mapError(
					(cause) =>
						new CodexAuthStoreError({
							reason: 'ReadFailed',
							message: `Failed to read the auth store at ${path}`,
							cause,
						}),
				),
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeed(emptyDocument),
						onSome: (text) =>
							decodeDocument(text).pipe(
								Effect.mapError(
									(cause) =>
										new CodexAuthStoreError({
											reason: 'InvalidDocument',
											message: `Auth store ${path} is not a JSON object of provider entries`,
											cause,
										}),
								),
							),
					}),
				),
			)

			const writeDocument = (document: CodexAuthDocument): Effect.Effect<void, CodexAuthStoreError> =>
				Effect.gen(function* () {
					yield* fs.makeDirectory(dirname(path), { recursive: true })
					const text = yield* encodeDocument(document)
					yield* fs.writeFileString(path, `${text}\n`, { mode: 0o600 })
					// writeFileString's mode only applies on creation; force 0600 on pre-existing documents too.
					yield* fs.chmod(path, 0o600)
				}).pipe(
					Effect.mapError(
						(cause) =>
							new CodexAuthStoreError({
								reason: 'WriteFailed',
								message: `Failed to write the auth store at ${path}`,
								cause,
							}),
					),
				)

			const load = Effect.gen(function* () {
				const document = yield* readDocument
				const entry = document[providerId]
				if (entry === undefined) return Option.none<CodexTokenData>()

				const token = decodeTokenEntry(entry)
				if (Option.isNone(token)) {
					yield* Effect.logWarning(`Ignoring invalid "${providerId}" entry in ${path}`)
				}

				return token
			}).pipe(
				Effect.catchTag('CodexAuthStoreError', (error) =>
					Effect.logWarning(`${error.message}; treating it as holding no credentials`, error.cause).pipe(
						Effect.as(Option.none<CodexTokenData>()),
					),
				),
				Effect.withSpan('fold.codexAuthStore.load'),
			)

			const save = Effect.fn('fold.codexAuthStore.save')(function* (token: CodexTokenData) {
				const document = yield* readDocument
				const entry = yield* encodeTokenEntry(token).pipe(
					Effect.mapError(
						(cause) =>
							new CodexAuthStoreError({
								reason: 'WriteFailed',
								message: `Failed to encode the "${providerId}" entry for ${path}`,
								cause,
							}),
					),
				)
				yield* writeDocument({ ...document, [providerId]: entry })
				return token
			})

			const clear = Effect.gen(function* () {
				const document = yield* readDocument
				if (document[providerId] === undefined) return
				const { [providerId]: _removed, ...rest } = document
				yield* writeDocument(rest)
			}).pipe(Effect.withSpan('fold.codexAuthStore.clear'))

			return { path, load, save, clear }
		}),
	)
