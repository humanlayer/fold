/**
 * This file defines event log backend descriptors for the public API: where a session's durable log
 * lives, described as data. `memoryEventLog` covers tests, browsers, and transient sessions;
 * `eventLogSource` is the extension seam through which platform packages (fold-agent JSONL, future
 * SQLite/Durable Object backends) contribute an EventLog service implementation without any layer
 * appearing in a public signature.
 */
import { Data, Effect, type Scope } from 'effect'

import type { EventLogService } from '../EventLog/EventLogService'

/**
 * Where one session's durable event log lives. Built with {@link memoryEventLog} or {@link eventLogSource}.
 * `R` is the host services the backend needs (a filesystem for JSONL); `startSession` requires them.
 */
export type FoldEventLog<R = never> = Data.TaggedEnum<{
	memory: {}
	source: { readonly make: Effect.Effect<EventLogService, never, Scope.Scope | R> }
}>

interface FoldEventLogDefinition extends Data.TaggedEnum.WithGenerics<1> {
	readonly taggedEnum: FoldEventLog<this['A']>
}

const FoldEventLog = Data.taggedEnum<FoldEventLogDefinition>()

/** Keep the session log in memory: fast, isolated, and gone when the session scope closes. */
export const memoryEventLog = (): FoldEventLog => FoldEventLog.memory()

/**
 * Back the session log with a caller-supplied EventLog service implementation. The effect runs once in
 * the session scope; construction failures are treated as infrastructure defects. Resuming an existing
 * log is this seam too: an implementation that loads prior entries replays them into the session.
 */
export const eventLogSource = <E, R = never>(
	make: Effect.Effect<EventLogService, E, Scope.Scope | R>,
): FoldEventLog<R> => FoldEventLog.source({ make: Effect.orDie(make) })
