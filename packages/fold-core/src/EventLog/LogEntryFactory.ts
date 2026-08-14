import { Clock, Effect, Schema } from 'effect'

import type { IdsService } from '../Ids'
import { EventLogInvalidEntryError } from './Errors'
import { LogEntry, LogEntryInput, type LogSeq } from './Schemas'

const invalidEntryError = (message: string, cause: unknown) =>
	new EventLogInvalidEntryError({
		operation: 'append',
		message,
		cause,
	})

/** Validate append input and assign the canonical EventLog sequence, event ID, and timestamp. */
export const makeStoredLogEntry = (
	input: LogEntryInput,
	seq: LogSeq,
	ids: Pick<IdsService, 'makeEventId'>,
): Effect.Effect<LogEntry, EventLogInvalidEntryError> =>
	Effect.gen(function* () {
		const decodedInput = yield* Schema.decodeUnknownEffect(LogEntryInput)(input).pipe(
			Effect.mapError((cause) => invalidEntryError('Invalid EventLog entry input', cause)),
		)
		const eventId = yield* ids.makeEventId
		const ts = yield* Clock.currentTimeMillis

		return yield* Schema.decodeUnknownEffect(LogEntry)({
			...decodedInput,
			seq,
			eventId,
			ts,
		}).pipe(Effect.mapError((cause) => invalidEntryError('Invalid stored EventLog entry', cause)))
	})
