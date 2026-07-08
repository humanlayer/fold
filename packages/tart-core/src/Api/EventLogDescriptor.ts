/**
 * This file defines event log backend descriptors for the public API: where a session's durable log
 * lives, described as data. `memoryEventLog` covers tests, browsers, and transient sessions;
 * `eventLogSource` is the extension seam through which platform packages (tart-agent JSONL, future
 * SQLite/Durable Object backends) contribute an EventLog service implementation without any layer
 * appearing in a public signature.
 */
import type { Effect, Scope } from 'effect'

import type { EventLogService } from '../EventLog/EventLogService'

/** Where one session's durable event log lives. Built with {@link memoryEventLog} or {@link eventLogSource}. */
export type TartEventLog =
	| { readonly _tag: 'memory' }
	| {
			readonly _tag: 'source'
			readonly make: Effect.Effect<EventLogService, unknown, Scope.Scope>
	  }

/** Keep the session log in memory: fast, isolated, and gone when the session scope closes. */
export const memoryEventLog = (): TartEventLog => ({ _tag: 'memory' })

/**
 * Back the session log with a caller-supplied EventLog service implementation. The effect runs once in
 * the session scope; construction failures are treated as infrastructure defects. Resuming an existing
 * log is this seam too: an implementation that loads prior entries replays them into the session.
 */
export const eventLogSource = (make: Effect.Effect<EventLogService, unknown, Scope.Scope>): TartEventLog => ({
	_tag: 'source',
	make,
})
