/**
 * This file implements the live AgentEvents layer over an unbounded PubSub, plus the ToolEventSink bridge
 * that republishes ToolRuntime progress as AgentEvents deltas. Publishing is live-only: a subscriber sees
 * only events published while its subscription is active, which is correct because deltas are ephemeral.
 * Durable log rows reach Session.events through the EventLog subscribe merge, not through this layer.
 */
import { Effect, Layer, PubSub, Stream } from 'effect'

import { ToolEventSink, type ToolEventSinkService } from '../ToolRuntime/ToolContextServices'
import { AgentEvents, type AgentEventsService, type FoldEvent } from './AgentEventsService'

/** Live AgentEvents layer backed by an unbounded, live-only PubSub of ephemeral events. */
export const makeAgentEvents: Effect.Effect<AgentEventsService> = Effect.gen(function* () {
	const pubsub = yield* PubSub.unbounded<FoldEvent>()

	const service: AgentEventsService = {
		publish: Effect.fn('fold.agent_events.publish')((event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid)),
		subscribe: Stream.fromPubSub(pubsub),
	}

	return service
})

/** The layer over {@link makeAgentEvents}. */
export const liveAgentEventsLayer: Layer.Layer<AgentEvents> = Layer.effect(AgentEvents, makeAgentEvents)

/**
 * Provide ToolEventSink by republishing each ToolRuntime progress event as an AgentEvents `tool-progress`
 * delta. This is the seam that lifts ephemeral tool progress into the merged session event stream, keeping
 * ToolRuntime unaware of AgentEvents.
 */
export const makeToolEventSink: Effect.Effect<ToolEventSinkService, never, AgentEvents> = Effect.gen(function* () {
	const agentEvents = yield* AgentEvents

	const service: ToolEventSinkService = {
		emit: (event) =>
			agentEvents.publish({
				kind: 'delta',
				agentId: event.agentId,
				parentAgentId: event.parentAgentId,
				toolCallId: event.toolCallId,
				part: { type: 'tool-progress', toolName: event.toolName, payload: event.payload },
			}),
	}

	return service
})

/** The layer over {@link makeToolEventSink}. */
export const toolEventSinkLayerFromAgentEvents: Layer.Layer<ToolEventSink, never, AgentEvents> = Layer.effect(
	ToolEventSink,
	makeToolEventSink,
)
