/**
 * File-backed OutputStore for large tool output (D19): one deterministic text file per tool call under
 * `<foldHome>/tool-output/<sessionId>/<toolCallId>.txt`. The durable log keeps the truncated result
 * the model saw; this store is retrieval-only supporting data, streamed from the first byte so
 * interrupted commands still leave partial output behind.
 */
import { join } from 'node:path'

import { SessionId, ToolCallId } from '@humanlayer/fold-core'
import { Cause, Clock, Context, Effect, Layer, Option, Schema } from 'effect'

import { defaultFoldHome } from '../Config/Load'
import { fileSystemFor, type FsToolOptions } from '../Fs/DefaultFileSystem'

const dayMs = 24 * 60 * 60 * 1000

/** Reference to one stored tool-output file. */
export class OutputStoreRef extends Schema.Class<OutputStoreRef>('fold-agent/OutputStoreRef')({
	sessionId: SessionId,
	toolCallId: ToolCallId,
	path: Schema.String,
}) {}

/** File-backed OutputStore operation failure. */
export class OutputStoreError extends Schema.TaggedErrorClass<OutputStoreError>()('OutputStoreError', {
	operation: Schema.Literals(['prepare', 'append', 'read']),
	path: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

/** Options for reading a stored output file. */
export type OutputStoreReadOptions = {
	/** 1-indexed line offset. Defaults to the first line. */
	readonly offset?: number
	/** Maximum number of lines to return. Defaults to the remainder of the file. */
	readonly limit?: number
}

/** Deep service surface for deterministic tool-output storage. */
export type OutputStoreService = {
	/** Current session this store is scoped to. */
	readonly sessionId: SessionId
	/** Directory containing this session's tool-output files. */
	readonly directory: string
	/** Compute the deterministic reference for one tool call without touching disk. */
	readonly refFor: (toolCallId: ToolCallId) => OutputStoreRef
	/** Ensure the output file exists and return its reference. */
	readonly prepare: (toolCallId: ToolCallId) => Effect.Effect<OutputStoreRef, OutputStoreError>
	/** Append one chunk to the output file, creating it if needed. */
	readonly append: (toolCallId: ToolCallId, chunk: string) => Effect.Effect<OutputStoreRef, OutputStoreError>
	/** Read output back for retrieval/debug surfaces. */
	readonly read: (ref: OutputStoreRef, options?: OutputStoreReadOptions) => Effect.Effect<string, OutputStoreError>
	/** Best-effort retention sweep. It logs and swallows failures. */
	readonly sweep: Effect.Effect<void>
}

/** OutputStore service tag for composition roots that want to provide it as an Effect service. */
export class OutputStore extends Context.Service<OutputStore, OutputStoreService>()('fold-agent/OutputStore') {}

/** Options for constructing a file-backed OutputStore. */
export type MakeOutputStoreOptions = {
	readonly sessionId: SessionId
	/** Defaults to `~/.fold`. */
	readonly foldHome?: string
	/** Files older than this are deleted by `sweep`. Defaults to 7 days. */
	readonly retentionMs?: number
	/** Filesystem override for tests. Defaults to Node's filesystem. */
	readonly fileSystem?: FsToolOptions['fileSystem']
}

/** Root directory for all stored tool output. */
export const toolOutputRootFor = (options?: { readonly foldHome?: string }): string =>
	join(options?.foldHome ?? defaultFoldHome(), 'tool-output')

/** Directory for one session's stored tool output. */
export const toolOutputSessionDirFor = (input: { readonly sessionId: SessionId; readonly foldHome?: string }): string =>
	join(toolOutputRootFor(input), input.sessionId)

/** Deterministic path for one tool call's full output. */
export const toolOutputPathFor = (input: {
	readonly sessionId: SessionId
	readonly toolCallId: ToolCallId
	readonly foldHome?: string
}): string => join(toolOutputSessionDirFor(input), `${input.toolCallId}.txt`)

const fileOperationError = (input: {
	readonly operation: 'prepare' | 'append' | 'read'
	readonly path: string
	readonly cause: unknown
}): OutputStoreError =>
	new OutputStoreError({
		operation: input.operation,
		path: input.path,
		message: `OutputStore ${input.operation} failed for ${input.path}: ${String(input.cause)}`,
		cause: input.cause,
	})

const logStoreError = (error: OutputStoreError): Effect.Effect<void> =>
	Effect.logWarning(error.message).pipe(Effect.annotateLogs({ operation: error.operation, path: error.path }))

const lineSlice = (content: string, options?: OutputStoreReadOptions): string => {
	const offset = Math.max(1, options?.offset ?? 1)
	const start = offset - 1
	const limit = options?.limit
	if (limit === undefined) return content.split('\n').slice(start).join('\n')

	return content
		.split('\n')
		.slice(start, start + Math.max(0, limit))
		.join('\n')
}

/** Construct a file-backed OutputStore service for one session. */
export const makeOutputStore = (options: MakeOutputStoreOptions): OutputStoreService => {
	const fs = fileSystemFor(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
	const foldHome = options.foldHome ?? defaultFoldHome()
	const sessionId = options.sessionId
	const directory = toolOutputSessionDirFor({ sessionId, foldHome })
	const retentionMs = options.retentionMs ?? 7 * dayMs

	const refFor = (toolCallId: ToolCallId): OutputStoreRef =>
		new OutputStoreRef({
			sessionId,
			toolCallId,
			path: toolOutputPathFor({ sessionId, toolCallId, foldHome }),
		})

	const prepare = (toolCallId: ToolCallId): Effect.Effect<OutputStoreRef, OutputStoreError> => {
		const ref = refFor(toolCallId)
		return fs.makeDirectory(directory, { recursive: true }).pipe(
			Effect.andThen(fs.writeFileString(ref.path, '', { flag: 'a' })),
			Effect.as(ref),
			Effect.mapError((cause) => fileOperationError({ operation: 'prepare', path: ref.path, cause })),
			Effect.tapError(logStoreError),
			Effect.withSpan('output_store.prepare', {
				attributes: { sessionId, toolCallId, path: ref.path },
			}),
		)
	}

	const append = (toolCallId: ToolCallId, chunk: string): Effect.Effect<OutputStoreRef, OutputStoreError> => {
		const ref = refFor(toolCallId)
		return fs.makeDirectory(directory, { recursive: true }).pipe(
			Effect.andThen(fs.writeFileString(ref.path, chunk, { flag: 'a' })),
			Effect.as(ref),
			Effect.mapError((cause) => fileOperationError({ operation: 'append', path: ref.path, cause })),
			Effect.tapError(logStoreError),
			Effect.withSpan('output_store.append', {
				attributes: { sessionId, toolCallId, path: ref.path, bytes: chunk.length },
			}),
		)
	}

	const read = (ref: OutputStoreRef, options?: OutputStoreReadOptions): Effect.Effect<string, OutputStoreError> =>
		fs.readFileString(ref.path).pipe(
			Effect.map((content) => lineSlice(content, options)),
			Effect.mapError((cause) => fileOperationError({ operation: 'read', path: ref.path, cause })),
			Effect.tapError(logStoreError),
			Effect.withSpan('output_store.read', {
				attributes: { sessionId: ref.sessionId, toolCallId: ref.toolCallId, path: ref.path },
			}),
		)

	const sweep = Effect.gen(function* () {
		const root = toolOutputRootFor({ foldHome })
		const now = yield* Clock.currentTimeMillis
		const sessions = yield* fs
			.readDirectory(root)
			.pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])))

		for (const sessionName of sessions) {
			const sessionDir = join(root, sessionName)
			const files = yield* fs
				.readDirectory(sessionDir)
				.pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])))

			for (const file of files) {
				if (!file.endsWith('.txt')) continue
				const path = join(sessionDir, file)
				const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.succeed(null)))
				if (info === null || info.type !== 'File') continue

				const mtime = Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() })
				if (now - mtime > retentionMs) yield* fs.remove(path).pipe(Effect.catch(() => Effect.void))
			}
		}
	}).pipe(
		Effect.catchCause((cause) => Effect.logWarning(`OutputStore sweep failed: ${Cause.pretty(cause)}`)),
		Effect.withSpan('output_store.sweep', { attributes: { sessionId, directory } }),
	)

	return { sessionId, directory, refFor, prepare, append, read, sweep }
}

/** Layer constructor for hosts that want OutputStore in `R`. */
export const outputStoreLayer = (options: MakeOutputStoreOptions): Layer.Layer<OutputStore> =>
	Layer.succeed(OutputStore, makeOutputStore(options))
