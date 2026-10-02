import { Clock, Effect, Schema } from 'effect'

import type { EventId } from '../Ids'
import { EventLogInvalidEntryError } from './Errors'
import { CURRENT_LOG_ENTRY_VERSION, LogEntry, LogEntryInput, type LogSeq } from './Schemas'

const invalidEntryError = (message: string, cause: unknown) =>
	new EventLogInvalidEntryError({
		operation: 'append',
		message,
		cause,
	})

/** Validate append input and assign the canonical event envelope under the given sequence number and event id. */
export const storedLogEntry = (
	input: LogEntryInput,
	seq: LogSeq,
	eventId: EventId,
): Effect.Effect<LogEntry, EventLogInvalidEntryError> =>
	Effect.gen(function* () {
		const decodedInput = yield* Schema.decodeEffect(LogEntryInput)(input).pipe(
			Effect.mapError((cause) => invalidEntryError('Invalid EventLog entry input', cause)),
		)
		const ts = yield* Clock.currentTimeMillis

		return yield* Schema.decodeEffect(LogEntry)({
			...decodedInput,
			seq,
			eventId,
			ts,
			version: CURRENT_LOG_ENTRY_VERSION,
		}).pipe(Effect.mapError((cause) => invalidEntryError('Invalid stored EventLog entry', cause)))
	})
