import { Context } from 'effect'
import type { Effect, Stream } from 'effect'

import type { EventLogError } from './Errors.ts'
import type { LogEntry, LogEntryInput, LogSeq } from './Schemas.ts'

/** Public EventLog service surface for a single tart session log. */
export type EventLogService = {
	/** Append an input entry, assigning the canonical seq and timestamp. */
	readonly append: (entry: LogEntryInput) => Effect.Effect<LogEntry, EventLogError>

	/** Replay stored entries from `fromSeq` and then complete. */
	readonly entries: (fromSeq?: LogSeq) => Stream.Stream<LogEntry, EventLogError>

	/** Replay stored entries from `fromSeq`, then continue following new appends. */
	readonly subscribe: (fromSeq?: LogSeq) => Stream.Stream<LogEntry, EventLogError>
}

/** Event-sourced append-only log service. One provided instance represents one session. */
export class EventLog extends Context.Service<EventLog, EventLogService>()('tart/EventLog') {}
