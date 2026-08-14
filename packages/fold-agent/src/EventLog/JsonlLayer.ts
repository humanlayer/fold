import { dirname } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import {
	EventLog,
	EventLogCorruptEntryError,
	EventLogInvalidEntryError,
	EventLogUnavailableError,
	LogEntry as LogEntrySchema,
	makeStoredLogEntry,
	type EventLogError,
	type EventLogService,
	type LogEntry,
	type LogEntryInput,
	type LogSeq,
} from '@humanlayer/fold-core'
import { Effect, FileSystem, Layer, PubSub, Ref, Schema, Semaphore, Stream, type PlatformError } from 'effect'

const textEncoder = new TextEncoder()

const entriesFrom = (entries: ReadonlyArray<LogEntry>, fromSeq: LogSeq) =>
	entries.filter((entry) => entry.seq >= fromSeq)

const unavailableError = (
	operation: 'append' | 'entries',
	message: string,
	retryable: boolean,
	cause: PlatformError.PlatformError,
) =>
	new EventLogUnavailableError({
		operation,
		message,
		retryable,
		cause,
	})

const corruptEntryError = (line: number, message: string, cause?: unknown, seq?: number) =>
	new EventLogCorruptEntryError({
		operation: 'entries',
		message,
		line,
		...(seq === undefined ? {} : { seq }),
		...(cause === undefined ? {} : { cause }),
	})

const invalidEntryError = (message: string, cause: unknown) =>
	new EventLogInvalidEntryError({
		operation: 'append',
		message,
		cause,
	})

const jsonlLines = (contents: string): ReadonlyArray<string> => {
	if (contents.length === 0) return []
	if (contents.endsWith('\n')) return contents.slice(0, -1).split('\n')
	return contents.split('\n')
}

const decodeJsonlLine = (line: string, lineNumber: number): Effect.Effect<LogEntry, EventLogCorruptEntryError> =>
	Effect.gen(function* () {
		if (line.length === 0) {
			return yield* corruptEntryError(lineNumber, `Empty JSONL line at line ${lineNumber}`)
		}

		const parsed = yield* Effect.try({
			try: (): unknown => JSON.parse(line),
			catch: (cause) => corruptEntryError(lineNumber, `Invalid JSON at line ${lineNumber}`, cause),
		})
		const entry = yield* Schema.decodeUnknownEffect(LogEntrySchema)(parsed).pipe(
			Effect.mapError((cause) =>
				corruptEntryError(lineNumber, `Invalid EventLog entry at line ${lineNumber}`, cause),
			),
		)
		const expectedSeq = lineNumber - 1

		if (entry.seq !== expectedSeq) {
			return yield* corruptEntryError(
				lineNumber,
				`Invalid EventLog sequence at line ${lineNumber}: expected ${expectedSeq}, got ${entry.seq}`,
				undefined,
				entry.seq,
			)
		}

		return entry
	})

const decodeJsonl = (contents: string): Effect.Effect<ReadonlyArray<LogEntry>, EventLogCorruptEntryError> =>
	Effect.forEach(jsonlLines(contents), (line, index) => decodeJsonlLine(line, index + 1), { concurrency: 1 })

const encodeJsonlLine = (entry: LogEntry): Effect.Effect<string, EventLogInvalidEntryError> =>
	Effect.gen(function* () {
		const encoded = yield* Schema.encodeUnknownEffect(LogEntrySchema)(entry).pipe(
			Effect.mapError((cause) => invalidEntryError('Unable to encode EventLog entry', cause)),
		)

		return yield* Effect.try({
			try: () => `${JSON.stringify(encoded)}\n`,
			catch: (cause) => invalidEntryError('Unable to serialize EventLog entry as JSON', cause),
		})
	})

const loadEntries = (
	fs: FileSystem.FileSystem,
	filePath: string,
): Effect.Effect<ReadonlyArray<LogEntry>, EventLogCorruptEntryError | EventLogUnavailableError> =>
	Effect.gen(function* () {
		yield* fs
			.makeDirectory(dirname(filePath), { recursive: true })
			.pipe(
				Effect.mapError((cause) =>
					unavailableError('entries', `Unable to create EventLog directory for ${filePath}`, false, cause),
				),
			)
		const exists = yield* fs
			.exists(filePath)
			.pipe(
				Effect.mapError((cause) =>
					unavailableError('entries', `Unable to inspect EventLog file ${filePath}`, false, cause),
				),
			)

		if (!exists) return []

		const contents = yield* fs
			.readFileString(filePath)
			.pipe(
				Effect.mapError((cause) =>
					unavailableError('entries', `Unable to read EventLog file ${filePath}`, false, cause),
				),
			)

		return yield* decodeJsonl(contents)
	})

const appendJsonlLine = (
	fs: FileSystem.FileSystem,
	filePath: string,
	line: string,
): Effect.Effect<void, EventLogUnavailableError> =>
	Effect.scoped(
		Effect.gen(function* () {
			const file = yield* fs
				.open(filePath, { flag: 'a' })
				.pipe(
					Effect.mapError((cause) =>
						unavailableError('append', `Unable to open EventLog file ${filePath}`, true, cause),
					),
				)

			yield* file
				.writeAll(textEncoder.encode(line))
				.pipe(
					Effect.mapError((cause) =>
						unavailableError('append', `Unable to write EventLog file ${filePath}`, true, cause),
					),
				)
			yield* file.sync.pipe(
				Effect.mapError((cause) =>
					unavailableError('append', `Unable to fsync EventLog file ${filePath}`, true, cause),
				),
			)
		}),
	)

/** JSONL-backed EventLog layer. The provided file path represents one fold session. */
export const layerJsonl = (filePath: string): Layer.Layer<EventLog, EventLogError, FileSystem.FileSystem> =>
	Layer.effect(
		EventLog,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const initialEntries = yield* loadEntries(fs, filePath)
			const entriesRef = yield* Ref.make<ReadonlyArray<LogEntry>>(initialEntries)
			const pubsub = yield* PubSub.unbounded<LogEntry>()
			const appendLock = yield* Semaphore.make(1)

			const append = Effect.fn('fold.event_log.jsonl.append')((input: LogEntryInput) =>
				appendLock.withPermit(
					Effect.gen(function* () {
						const current = yield* Ref.get(entriesRef)
						const stored = yield* makeStoredLogEntry(input, current.length)
						const line = yield* encodeJsonlLine(stored)

						yield* appendJsonlLine(fs, filePath, line)
						yield* Ref.set(entriesRef, [...current, stored])
						yield* PubSub.publish(pubsub, stored)

						return stored
					}),
				),
			)

			const entries: EventLogService['entries'] = (fromSeq = 0) =>
				Stream.fromIterableEffect(
					Ref.get(entriesRef).pipe(Effect.map((snapshot) => entriesFrom(snapshot, fromSeq))),
				)

			const subscribe: EventLogService['subscribe'] = (fromSeq = 0) =>
				Stream.unwrap(
					appendLock.withPermit(
						Effect.gen(function* () {
							const subscription = yield* PubSub.subscribe(pubsub)
							const snapshot = yield* Ref.get(entriesRef)

							return Stream.fromIterable(entriesFrom(snapshot, fromSeq)).pipe(
								Stream.concat(
									Stream.fromSubscription(subscription).pipe(
										Stream.filter((entry) => entry.seq >= fromSeq),
									),
								),
							)
						}),
					),
				)

			return { append, entries, subscribe }
		}),
	)

/** Node-backed JSONL EventLog layer using `@effect/platform-node/NodeFileSystem.layer`. */
export const layerJsonlNode = (filePath: string): Layer.Layer<EventLog, EventLogError> =>
	layerJsonl(filePath).pipe(Layer.provide(NodeFileSystem.layer))
