/**
 * This file defines the AgentEvents service contract - the ephemeral event spine for one session. It
 * carries the merged `FoldEvent` shape that Session exposes: durable `log` rows (folded in by
 * Session.events from the EventLog) and ephemeral `delta` fragments (streaming text/reasoning and tool
 * progress) that are published live and never persisted. AgentEvents itself only holds the delta side.
 *
 * The live AgentEvents service runs over an unbounded PubSub. Publishing is live-only: a subscriber sees
 * only events published while its subscription is active, which is correct because deltas are ephemeral.
 * Durable log rows reach Session.events through the EventLog subscribe merge, not through this service.
 */
import { Context, Effect, type Schema, Stream, Layer, PubSub } from 'effect'

import type { LogEntry } from '../EventLog/Schemas'
import type { AgentId, ToolCallId } from '../Ids'

/**
 * One ephemeral streaming fragment. Deltas are transport-only UI signals and are never written to the
 * durable log, so they are plain TypeScript unions rather than persisted schemas.
 */
export type DeltaPart =
	| { readonly type: 'text-delta'; readonly id: string; readonly delta: string }
	| { readonly type: 'reasoning-delta'; readonly id: string; readonly delta: string }
	| { readonly type: 'tool-progress'; readonly toolName: string; readonly payload: Schema.Json }

/** One event on the merged session stream: a durable log row or an ephemeral delta. */
export type FoldEvent =
	| { readonly kind: 'log'; readonly entry: LogEntry }
	| {
			readonly kind: 'delta'
			readonly agentId: AgentId
			readonly parentAgentId: AgentId | null
			readonly toolCallId: ToolCallId | null
			readonly part: DeltaPart
	  }

/** Public AgentEvents service surface. */
export type AgentEventsService = {
	/** Publish one event to every currently subscribed stream. */
	readonly publish: (event: FoldEvent) => Effect.Effect<void>

	/** A live-only stream of published events; each run establishes a fresh subscription with no replay. */
	readonly subscribe: Stream.Stream<FoldEvent>
}

/** AgentEvents service tag. */
export class AgentEvents extends Context.Service<AgentEvents, AgentEventsService>()('fold/AgentEvents', {
	/** Backed by an unbounded, live-only PubSub of ephemeral events. */
	make: Effect.gen(function* () {
		const pubsub = yield* PubSub.unbounded<FoldEvent>()

		const service: AgentEventsService = {
			publish: Effect.fn('fold.agent_events.publish')((event) =>
				PubSub.publish(pubsub, event).pipe(Effect.asVoid),
			),
			subscribe: Stream.fromPubSub(pubsub),
		}

		return service
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
