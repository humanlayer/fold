import { Effect, Layer, PubSub, Ref, Semaphore, Stream } from 'effect'

import { EventLog, type EventLogService } from './EventLogService'
import { makeStoredLogEntry } from './LogEntryFactory'
import type { LogEntry, LogEntryInput, LogSeq } from './Schemas'

const entriesFrom = (entries: ReadonlyArray<LogEntry>, fromSeq: LogSeq) =>
	entries.filter((entry) => entry.seq >= fromSeq)

/** In-memory EventLog implementation for tests, browser hosts, and transient sessions. */
export const layerInMemoryEventLog: Layer.Layer<EventLog> = Layer.effect(
	EventLog,
	Effect.gen(function* () {
		const entriesRef = yield* Ref.make<ReadonlyArray<LogEntry>>([])
		const pubsub = yield* PubSub.unbounded<LogEntry>()
		const appendLock = yield* Semaphore.make(1)

		const append = Effect.fn('fold.event_log.memory.append')((input: LogEntryInput) =>
			appendLock.withPermit(
				Effect.gen(function* () {
					const current = yield* Ref.get(entriesRef)
					const stored = yield* makeStoredLogEntry(input, current.length)

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
