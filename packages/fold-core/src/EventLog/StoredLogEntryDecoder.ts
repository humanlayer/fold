import { Effect, Schema } from 'effect'

import { EventLogCorruptEntryError, EventLogUnsupportedVersionError } from './Errors'
import {
	CURRENT_LOG_ENTRY_VERSION,
	LogEntryV1,
	SUPPORTED_LOG_ENTRY_VERSIONS,
	StoredLogEntryEnvelope,
	type LogEntry,
} from './Schemas'

const PersistedRecord = Schema.Record(Schema.String, Schema.Unknown)

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

const corruptEntry = (message: string, cause: unknown, seq?: number) => {
	const input: Mutable<ConstructorParameters<typeof EventLogCorruptEntryError>[0]> = {
		operation: 'entries',
		message,
		cause,
	}
	if (seq !== undefined) {
		input.seq = seq
	}

	return new EventLogCorruptEntryError(input)
}

/**
 * Decode one persisted Fold event by its wire-format version.
 *
 * Fold runtimes carry every historical decoder they support; hosts do not load a package dynamically
 * or interpret versions themselves. Each decoder upcasts its historical wire shape to the current
 * {@link LogEntry} model. Writers always emit {@link CURRENT_LOG_ENTRY_VERSION}. When a future v2 is
 * introduced, keep `LogEntryV1` unchanged, add `LogEntryV2` plus its upcaster here, and add `2` to
 * `SUPPORTED_LOG_ENTRY_VERSIONS`.
 *
 * Events written before per-entry versioning are treated as legacy v1. Unknown versions fail explicitly
 * so an older runtime never guesses how to replay newer state.
 */
export const decodeStoredLogEntry = Effect.fn('fold.event_log.decode_stored_entry')(
	(input: unknown) =>
		Effect.gen(function* () {
			const record = yield* Schema.decodeUnknownEffect(PersistedRecord)(input).pipe(
				Effect.mapError((cause) => corruptEntry('Persisted EventLog entry is not an object', cause)),
			)
			const envelope = yield* Schema.decodeUnknownEffect(StoredLogEntryEnvelope)(record).pipe(
				Effect.mapError((cause) => corruptEntry('Persisted EventLog entry has an invalid envelope', cause)),
			)
			const version = envelope.version ?? CURRENT_LOG_ENTRY_VERSION

			switch (version) {
				case 1:
					return yield* Schema.decodeUnknownEffect(LogEntryV1)({
						...record,
						version: CURRENT_LOG_ENTRY_VERSION,
					}).pipe(
						Effect.mapError((cause) =>
							corruptEntry('Persisted EventLog v1 entry has an invalid payload', cause, envelope.seq),
						),
					)
				default:
					return yield* new EventLogUnsupportedVersionError({
						operation: 'entries',
						message: `Fold event format v${version} is not supported by this runtime`,
						version,
						seq: envelope.seq,
						supportedVersions: [...SUPPORTED_LOG_ENTRY_VERSIONS],
					})
			}
		}) satisfies Effect.Effect<LogEntry, EventLogCorruptEntryError | EventLogUnsupportedVersionError>,
)
