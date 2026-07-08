/**
 * File-backed Codex credential store: one provider-keyed JSON document (default `~/.tart/auth.json`)
 * holding OAuth tokens only (D23). Field names are agentlayer-compatible (`access`/`refresh`/`expires`/
 * `accountId`), so existing entries copy across verbatim. Reads degrade to "no credentials" on missing
 * or malformed data - the document may hold other providers' entries, so a bad codex entry is skipped,
 * never clobbered; writes merge over the existing document and force `0600` permissions. The FileSystem
 * is a default-or-override seam like tart-agent tools: tests pass an implementation, everyone else gets
 * the Node platform filesystem.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Context, Effect, FileSystem, Layer, Option, Schema } from 'effect'

/** Milliseconds before nominal expiry a token is already treated as expired (clanka parity). */
export const TOKEN_EXPIRY_BUFFER_MS = 30_000

/** Default location of the tart auth store. */
export const defaultAuthStorePath = (): string => join(homedir(), '.tart', 'auth.json')

/** One stored Codex OAuth credential. `expires` is epoch milliseconds for the access token. */
export class CodexTokenData extends Schema.Class<CodexTokenData>('tart/CodexTokenData')({
	type: Schema.Literal('oauth'),
	access: Schema.String,
	refresh: Schema.String,
	expires: Schema.Number,
	accountId: Schema.optional(Schema.String),
}) {
	/** True when the token is expired - or within the safety buffer of expiring - at `nowMs`. */
	isExpired(nowMs: number): boolean {
		return this.expires < nowMs + TOKEN_EXPIRY_BUFFER_MS
	}
}

/** Auth store persistence failure (reads never fail - they degrade to absent credentials). */
export class CodexAuthStoreError extends Schema.TaggedErrorClass<CodexAuthStoreError>()('CodexAuthStoreError', {
	reason: Schema.Literals(['WriteFailed']),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

/** The credential store one CodexAuth instance persists through. */
export type CodexAuthStore = {
	/** Absolute path of the backing JSON document (used in error messages and guidance). */
	readonly path: string
	readonly load: Effect.Effect<Option.Option<CodexTokenData>>
	readonly save: (token: CodexTokenData) => Effect.Effect<CodexTokenData, CodexAuthStoreError>
	readonly clear: Effect.Effect<void, CodexAuthStoreError>
}

/** Options for {@link makeCodexAuthStore}. */
export type MakeCodexAuthStoreOptions = {
	/** Path of the auth document. Defaults to `~/.tart/auth.json`. */
	readonly path?: string
	/** Key of this provider's entry in the document. Defaults to `codex`. */
	readonly providerId?: string
	/** FileSystem implementation override. Defaults to the Node platform filesystem. */
	readonly fileSystem?: FileSystem.FileSystem
}

let nodeFileSystem: FileSystem.FileSystem | null = null

/** The process-wide Node FileSystem service, built lazily once (layer construction is synchronous). */
export const defaultNodeFileSystem = (): FileSystem.FileSystem => {
	if (nodeFileSystem === null) {
		nodeFileSystem = Effect.runSync(
			Effect.scoped(
				Layer.build(NodeFileSystem.layer).pipe(
					Effect.map((context) => Context.get(context, FileSystem.FileSystem)),
				),
			),
		)
	}

	return nodeFileSystem
}

/** The auth document is provider-keyed; entries other than ours are opaque and preserved verbatim. */
const AuthDocument = Schema.Record(Schema.String, Schema.Unknown)

const decodeDocument = Schema.decodeUnknownOption(Schema.fromJsonString(AuthDocument))

const decodeToken = Schema.decodeUnknownOption(CodexTokenData)

const encodeToken = (token: CodexTokenData): Record<string, unknown> => ({
	type: token.type,
	access: token.access,
	refresh: token.refresh,
	expires: token.expires,
	...(token.accountId === undefined ? {} : { accountId: token.accountId }),
})

/** Build a file-backed Codex credential store. */
export const makeCodexAuthStore = (options?: MakeCodexAuthStoreOptions): CodexAuthStore => {
	const fs = options?.fileSystem ?? defaultNodeFileSystem()
	const path = options?.path ?? defaultAuthStorePath()
	const providerId = options?.providerId ?? 'codex'

	const readDocument: Effect.Effect<Record<string, unknown>> = fs.readFileString(path).pipe(
		Effect.flatMap((content) => {
			const document = decodeDocument(content)
			return Option.isSome(document)
				? Effect.succeed(document.value)
				: Effect.logWarning(`Auth store ${path} is not a JSON object; treating it as empty`).pipe(
						Effect.as<Record<string, unknown>>({}),
					)
		}),
		// A missing (or unreadable) document is simply "no credentials stored yet".
		Effect.catch(() => Effect.succeed<Record<string, unknown>>({})),
	)

	const writeDocument = (document: Record<string, unknown>): Effect.Effect<void, CodexAuthStoreError> =>
		Effect.gen(function* () {
			yield* fs.makeDirectory(dirname(path), { recursive: true })
			yield* fs.writeFileString(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
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

		const token = decodeToken(entry)
		if (Option.isNone(token)) {
			yield* Effect.logWarning(`Ignoring invalid "${providerId}" entry in ${path}`)
		}

		return token
	}).pipe(Effect.withSpan('tart.codexAuthStore.load'))

	const save = (token: CodexTokenData) =>
		Effect.gen(function* () {
			const document = yield* readDocument
			yield* writeDocument({ ...document, [providerId]: encodeToken(token) })
			return token
		}).pipe(Effect.withSpan('tart.codexAuthStore.save'))

	const clear = Effect.gen(function* () {
		const document = yield* readDocument
		if (document[providerId] === undefined) return
		const { [providerId]: _removed, ...rest } = document
		yield* writeDocument(rest)
	}).pipe(Effect.withSpan('tart.codexAuthStore.clear'))

	return { path, load, save, clear }
}
