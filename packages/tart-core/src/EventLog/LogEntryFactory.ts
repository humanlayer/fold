import { Clock, Effect, Schema } from 'effect'

import { EventLogInvalidEntryError } from './Errors.ts'
import { LogEntry, LogEntryInput, type LogSeq } from './Schemas.ts'

const invalidEntryError = (message: string, cause: unknown) =>
	new EventLogInvalidEntryError({
		operation: 'append',
		message,
		cause,
	})

/** Validate append input and assign the canonical EventLog envelope fields. */
export const makeStoredLogEntry = (
	input: LogEntryInput,
	seq: LogSeq,
): Effect.Effect<LogEntry, EventLogInvalidEntryError> =>
	Effect.gen(function* () {
		const decodedInput = yield* Schema.decodeUnknownEffect(LogEntryInput)(input).pipe(
			Effect.mapError((cause) => invalidEntryError('Invalid EventLog entry input', cause)),
		)
		const ts = yield* Clock.currentTimeMillis

		return yield* Schema.decodeUnknownEffect(LogEntry)({ ...decodedInput, seq, ts }).pipe(
			Effect.mapError((cause) => invalidEntryError('Invalid stored EventLog entry', cause)),
		)
	})
