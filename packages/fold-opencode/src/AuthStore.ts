/** File-backed OpenCode credentials stored under the `opencode` key in `~/.fold/auth.json`. */
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
	expires: Schema.Number,
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

export class OpenCodeAuthStoreError extends Schema.TaggedErrorClass<OpenCodeAuthStoreError>()(
	'OpenCodeAuthStoreError',
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

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
const Document = Schema.Record(Schema.String, Schema.Unknown)
const decodeDocument = Schema.decodeUnknownOption(Schema.fromJsonString(Document))
const decodeToken = Schema.decodeUnknownOption(OpenCodeTokenData)

/** Construct a provider-keyed credential store; unrelated entries are preserved. */
export const makeOpenCodeAuthStore = (options?: MakeOpenCodeAuthStoreOptions): OpenCodeAuthStore => {
	const fs = options?.fileSystem ?? defaultFs()
	const path = options?.path ?? defaultOpenCodeAuthStorePath()
	const providerId = options?.providerId ?? 'opencode'
	const read: Effect.Effect<Record<string, unknown>> = fs.readFileString(path).pipe(
		Effect.map((text): Record<string, unknown> => Option.getOrElse(decodeDocument(text), () => ({}))),
		Effect.catch(() => Effect.succeed<Record<string, unknown>>({})),
	)
	const write = (document: Record<string, unknown>) =>
		Effect.gen(function* () {
			yield* fs.makeDirectory(dirname(path), { recursive: true })
			yield* fs.writeFileString(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
			yield* fs.chmod(path, 0o600)
		}).pipe(Effect.mapError((cause) => new OpenCodeAuthStoreError({ message: `Failed to write ${path}`, cause })))
	return {
		path,
		load: read.pipe(
			Effect.map((document) => decodeToken(document[providerId])),
			Effect.withSpan('fold.opencode_auth_store.load'),
		),
		save: (token) =>
			read.pipe(
				Effect.flatMap((document) => write({ ...document, [providerId]: token })),
				Effect.as(token),
				Effect.withSpan('fold.opencode_auth_store.save'),
			),
		clear: read.pipe(
			Effect.flatMap((document) => {
				const { [providerId]: _removed, ...rest } = document
				return write(rest)
			}),
			Effect.withSpan('fold.opencode_auth_store.clear'),
		),
	}
}
