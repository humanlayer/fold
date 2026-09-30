/**
 * A fold event log in a Durable Object's SQLite: one object is one session's log. Opening the log loads
 * every row, so `resumeSession` replays them; appends write through before they publish. This mirrors
 * fold-agent's JSONL log with a table in place of the file.
 *
 * Queries run on the raw SQLite handle, which is synchronous and needs nothing at call time, so the log
 * fold holds needs nothing either.
 */
import {
	EventLogCorruptEntryError,
	EventLogInvalidEntryError,
	EventLogUnavailableError,
	Ids,
	LogEntry,
	decodeStoredLogEntry,
	layerLiveIdFactory,
	makeStoredLogEntry,
	type EventLogError,
	type EventLogOperation,
	type EventLogService,
	type LogEntryInput,
	type LogSeq,
} from '@humanlayer/fold-core'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Context, Effect, Layer, PubSub, Ref, Schema, Semaphore, Stream } from 'effect'

type LogRow = { readonly seq: number; readonly entry: string }

const entriesFrom = (entries: ReadonlyArray<LogEntry>, fromSeq: LogSeq) =>
	entries.filter((entry) => entry.seq >= fromSeq)

const LogEntryJson = Schema.fromJsonString(LogEntry)

/** Parse a row's JSON, then decode it by its stored version (older versions upcast to the current shape). */
const decodeRow = (row: LogRow) =>
	Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(row.entry).pipe(
		Effect.mapError(
			(cause) =>
				new EventLogCorruptEntryError({
					operation: 'entries',
					message: `Invalid JSON in fold_log at seq ${row.seq}`,
					seq: row.seq,
					cause,
				}),
		),
		Effect.flatMap(decodeStoredLogEntry),
	)

const encodeEntry = (entry: LogEntry) =>
	Schema.encodeEffect(LogEntryJson)(entry).pipe(
		Effect.mapError(
			(cause) =>
				new EventLogInvalidEntryError({
					operation: 'append',
					message: 'Unable to encode EventLog entry',
					cause,
				}),
		),
	)

export class DurableObjectEventLog extends Context.Service<
	DurableObjectEventLog,
	{
		/** Open this object's log. Run it once the object is live: it reads the object's SQLite. */
		readonly open: Effect.Effect<EventLogService, EventLogError>
	}
>()('alchemy-cloudflare/DurableObjectEventLog') {
	static readonly layer = Layer.effect(
		DurableObjectEventLog,
		Effect.gen(function* () {
			const { raw } = yield* Cloudflare.DurableObjectState
			const ids = yield* Ids

			const query = <Row extends Record<string, string | number> = Record<string, never>>(
				operation: EventLogOperation,
				sql: string,
				...bindings: Array<string | number>
			) =>
				Effect.try({
					try: () => raw.storage.sql.exec<Row>(sql, ...bindings).toArray(),
					catch: (cause) =>
						new EventLogUnavailableError({
							operation,
							message: 'fold_log query failed',
							retryable: false,
							cause,
						}),
				})

			const open = Effect.gen(function* () {
				yield* query(
					'entries',
					'CREATE TABLE IF NOT EXISTS fold_log (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL)',
				)
				const rows = yield* query<LogRow>('entries', 'SELECT seq, entry FROM fold_log ORDER BY seq')
				const initialEntries = yield* Effect.forEach(rows, decodeRow)

				const entriesRef = yield* Ref.make<ReadonlyArray<LogEntry>>(initialEntries)
				const pubsub = yield* PubSub.unbounded<LogEntry>()
				const appendLock = yield* Semaphore.make(1)

				const append = Effect.fn('alchemy_cloudflare.event_log.append')((input: LogEntryInput) =>
					appendLock.withPermit(
						Effect.gen(function* () {
							const current = yield* Ref.get(entriesRef)
							const stored = yield* makeStoredLogEntry(input, current.length, ids)
							const entry = yield* encodeEntry(stored)

							yield* query('append', 'INSERT INTO fold_log (seq, entry) VALUES (?, ?)', stored.seq, entry)
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
			})

			return DurableObjectEventLog.of({ open })
		}),
	).pipe(Layer.provide(layerLiveIdFactory))
}
