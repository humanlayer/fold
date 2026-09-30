/**
 * File-backed OpenCode credentials stored under the `opencode` key in `~/.fold/auth.json`. The document
 * is provider-keyed JSON shared with other providers; only our entry decodes as a token. A missing file
 * is an empty document. `load` degrades to "no credentials" (with a logged warning) on an unreadable or
 * corrupt document or a bad entry; `save`/`clear` fail on an unreadable or corrupt document rather than
 * clobber it.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Context, Effect, FileSystem, Layer, Option, Schema } from 'effect'

export const TOKEN_EXPIRY_BUFFER_MS = 30_000
export const defaultOpenCodeAuthStorePath = (): string => join(homedir(), '.fold', 'auth.json')

/** OAuth credential minted by OpenCode Console's device flow. */
export class OpenCodeTokenData extends Schema.Class<OpenCodeTokenData>('fold/OpenCodeTokenData')({
	type: Schema.Literal('oauth'),
	access: Schema.String,
	refresh: Schema.String,
	expires: Schema.Finite,
	metadata: Schema.optional(
		Schema.Struct({
			server: Schema.String,
			accountID: Schema.String,
			email: Schema.String,
			orgID: Schema.optional(Schema.String),
			orgName: Schema.optional(Schema.String),
		}),
	),
}) {
	isExpired(nowMs: number): boolean {
		return this.expires < nowMs + TOKEN_EXPIRY_BUFFER_MS
	}
}

/** Auth store failure: the document could not be read, is not provider-keyed JSON, or could not be written. */
export class OpenCodeAuthStoreError extends Schema.TaggedError<OpenCodeAuthStoreError>()('OpenCodeAuthStoreError', {
	reason: Schema.Literals(['ReadFailed', 'InvalidDocument', 'WriteFailed']),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export type OpenCodeAuthStore = {
	readonly path: string
	readonly load: Effect.Effect<Option.Option<OpenCodeTokenData>>
	readonly save: (token: OpenCodeTokenData) => Effect.Effect<OpenCodeTokenData, OpenCodeAuthStoreError>
	readonly clear: Effect.Effect<void, OpenCodeAuthStoreError>
}
export type MakeOpenCodeAuthStoreOptions = {
	readonly path?: string
	readonly providerId?: string
	readonly fileSystem?: FileSystem.FileSystem
}
let nodeFs: FileSystem.FileSystem | null = null
const defaultFs = (): FileSystem.FileSystem => {
	if (nodeFs === null)
		nodeFs = Effect.runSync(
			Effect.scoped(
				Layer.build(NodeFileSystem.layer).pipe(Effect.map((c) => Context.get(c, FileSystem.FileSystem))),
			),
		)
	return nodeFs
}
/** The auth document: JSON entries keyed by provider id. Entries other than ours are preserved verbatim. */
export const OpenCodeAuthDocument = Schema.Record(Schema.String, Schema.Json)
export type OpenCodeAuthDocument = typeof OpenCodeAuthDocument.Type

const emptyDocument: OpenCodeAuthDocument = {}
const decodeDocument = Schema.decodeEffect(Schema.fromJsonString(OpenCodeAuthDocument))
const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(OpenCodeAuthDocument, { space: 2 }))

/** Our entry's JSON codec: decodes a document value into a token and encodes a token back to JSON. */
const OpenCodeTokenEntry = Schema.toCodecJson(OpenCodeTokenData)
const decodeTokenEntry = Schema.decodeOption(OpenCodeTokenEntry)
const encodeTokenEntry = Schema.encodeEffect(OpenCodeTokenEntry)

/** Construct a provider-keyed credential store; unrelated entries are preserved. */
export const makeOpenCodeAuthStore = (options?: MakeOpenCodeAuthStoreOptions): OpenCodeAuthStore => {
	const fs = options?.fileSystem ?? defaultFs()
	const path = options?.path ?? defaultOpenCodeAuthStorePath()
	const providerId = options?.providerId ?? 'opencode'

	// A missing document is simply "no credentials stored yet"; any other read failure is real.
	const read: Effect.Effect<OpenCodeAuthDocument, OpenCodeAuthStoreError> = fs.readFileString(path).pipe(
		Effect.asSome,
		Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(Option.none<string>())),
		Effect.mapError(
			(cause) => new OpenCodeAuthStoreError({ reason: 'ReadFailed', message: `Failed to read ${path}`, cause }),
		),
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.succeed(emptyDocument),
				onSome: (text) =>
					decodeDocument(text).pipe(
						Effect.mapError(
							(cause) =>
								new OpenCodeAuthStoreError({
									reason: 'InvalidDocument',
									message: `${path} is not a JSON object of provider entries`,
									cause,
								}),
						),
					),
			}),
		),
	)
	const write = (document: OpenCodeAuthDocument) =>
		Effect.gen(function* () {
			yield* fs.makeDirectory(dirname(path), { recursive: true })
			const text = yield* encodeDocument(document)
			yield* fs.writeFileString(path, `${text}\n`, { mode: 0o600 })
			yield* fs.chmod(path, 0o600)
		}).pipe(
			Effect.mapError(
				(cause) =>
					new OpenCodeAuthStoreError({ reason: 'WriteFailed', message: `Failed to write ${path}`, cause }),
			),
		)
	const load = Effect.gen(function* () {
		const document = yield* read
		const entry = document[providerId]
		if (entry === undefined) return Option.none<OpenCodeTokenData>()
		const token = decodeTokenEntry(entry)
		if (Option.isNone(token)) yield* Effect.logWarning(`Ignoring invalid "${providerId}" entry in ${path}`)
		return token
	}).pipe(
		Effect.catchTag('OpenCodeAuthStoreError', (error) =>
			Effect.logWarning(`${error.message}; treating it as holding no credentials`, error.cause).pipe(
				Effect.as(Option.none<OpenCodeTokenData>()),
			),
		),
		Effect.withSpan('fold.opencode_auth_store.load'),
	)
	const save = Effect.fn('fold.opencode_auth_store.save')(function* (token: OpenCodeTokenData) {
		const document = yield* read
		const entry = yield* encodeTokenEntry(token).pipe(
			Effect.mapError(
				(cause) =>
					new OpenCodeAuthStoreError({
						reason: 'WriteFailed',
						message: `Failed to encode the "${providerId}" entry for ${path}`,
						cause,
					}),
			),
		)
		yield* write({ ...document, [providerId]: entry })
		return token
	})
	const clear = Effect.gen(function* () {
		const document = yield* read
		if (document[providerId] === undefined) return
		const { [providerId]: _removed, ...rest } = document
		yield* write(rest)
	}).pipe(Effect.withSpan('fold.opencode_auth_store.clear'))
	return { path, load, save, clear }
}
