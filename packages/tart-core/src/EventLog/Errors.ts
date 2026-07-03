import { Schema } from 'effect'

/** EventLog operation names used in typed error payloads. */
export const EventLogOperation = Schema.Literals(['append', 'entries', 'subscribe']).annotate({
	identifier: 'EventLogOperation',
})
export type EventLogOperation = typeof EventLogOperation.Type

/** Append input failed schema validation or violated a log invariant. */
export class EventLogInvalidEntryError extends Schema.TaggedErrorClass<EventLogInvalidEntryError>()(
	'EventLogInvalidEntryError',
	{
		operation: EventLogOperation,
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

/** The backing log store could not be read, written, or subscribed to. */
export class EventLogUnavailableError extends Schema.TaggedErrorClass<EventLogUnavailableError>()(
	'EventLogUnavailableError',
	{
		operation: EventLogOperation,
		message: Schema.String,
		retryable: Schema.Boolean,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

/** Persisted log data could not be decoded or is internally inconsistent. */
export class EventLogCorruptEntryError extends Schema.TaggedErrorClass<EventLogCorruptEntryError>()(
	'EventLogCorruptEntryError',
	{
		operation: EventLogOperation,
		message: Schema.String,
		seq: Schema.optional(Schema.Number),
		line: Schema.optional(Schema.Number),
		cause: Schema.optional(Schema.Defect()),
	},
) {}

/** Public EventLog error union. */
export type EventLogError = EventLogInvalidEntryError | EventLogUnavailableError | EventLogCorruptEntryError
