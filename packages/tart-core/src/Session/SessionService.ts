/**
 * This file defines the Session service contract - the public SDK facade over one tart session. A caller
 * starts a session (which mints the session and root-agent ids and appends the first durable rows), sends
 * user turns to the root agent, and subscribes to a merged stream of durable log rows and ephemeral
 * deltas. One provided Session instance represents exactly one session, mirroring EventLog.
 */
import { Context, Schema } from 'effect'
import type { Effect, Stream } from 'effect'

import type { TartEvent } from '../AgentEvents/AgentEventsService'
import type { ActiveModel, AgentFinishedLogEntry, LogSeq } from '../EventLog/Schemas'
import type { AgentId, SessionId } from '../Ids'
import type { SessionAlreadyStartedError, SessionNotStartedError } from './Errors'

/** Input for starting the one session owned by this Session instance. */
export type StartSessionInput = {
	/** Host working directory recorded on `session_started`; omit (or pass null) on hosts without a filesystem. */
	readonly cwd?: string | null
	readonly model: ActiveModel
	/** One leading system block, an ordered set of blocks (one system message each), or null for none. */
	readonly systemPrompt: string | ReadonlyArray<string> | null
	readonly meta?: Readonly<Record<string, typeof Schema.Json.Type>>
	/** Pre-minted session id (hosts that name the log location by session id - D5); defaults to fresh. */
	readonly sessionId?: SessionId
}

/** Identity minted by `start`: the session and its root agent. */
export type StartedSession = {
	readonly sessionId: SessionId
	readonly rootAgentId: AgentId
}

/** Input for switching the root agent to a different model (a new epoch - D17). */
export type SwitchSessionModelInput = {
	readonly model: ActiveModel
	/** The agent's own prompt blocks, recomposed with the new model family's base prompt. */
	readonly systemPrompt: string | ReadonlyArray<string> | null
	readonly reason?: string | null
}

/**
 * Public SDK facade for one session.
 *
 * `start` appends `session_started` as the first durable row and starts the root agent; a second call
 * fails with `SessionAlreadyStartedError`. `adopt` claims the same slot WITHOUT any durable writes -
 * the resume path (slice 2): identity comes from a replayed `session_started`, and the log continues
 * where it left off. `send` runs one user turn on the root agent and resolves with the durable
 * `agent-finished` entry; a call before `start`/`adopt` fails with `SessionNotStartedError`.
 * `switchModel` writes the D17 epoch transition for the root agent (`model-change`, recomposed leading
 * `system-message`, `tools-change`); callers still provide/swap the LanguageModel for the new provider.
 * `events` merges durable log rows with ephemeral deltas into one error-free stream.
 */
export type SessionService = {
	readonly start: (input: StartSessionInput) => Effect.Effect<StartedSession, SessionAlreadyStartedError>
	readonly adopt: (input: StartedSession) => Effect.Effect<StartedSession, SessionAlreadyStartedError>
	readonly send: (input: { readonly text: string }) => Effect.Effect<AgentFinishedLogEntry, SessionNotStartedError>
	readonly switchModel: (input: SwitchSessionModelInput) => Effect.Effect<void, SessionNotStartedError>
	readonly events: (fromSeq?: LogSeq) => Stream.Stream<TartEvent>
}

/** Session service tag. One provided instance represents one session. */
export class Session extends Context.Service<Session, SessionService>()('tart/Session') {}
