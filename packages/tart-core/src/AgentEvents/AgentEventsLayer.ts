/**
 * This file implements the live AgentEvents layer over an unbounded PubSub, plus the ToolEventSink bridge
 * that republishes ToolRuntime progress as AgentEvents deltas. Publishing is live-only: a subscriber sees
 * only events published while its subscription is active, which is correct because deltas are ephemeral.
 * Durable log rows reach Session.events through the EventLog subscribe merge, not through this layer.
 */
import { Effect, Layer, PubSub, Stream } from 'effect'

import { ToolEventSink, type ToolEventSinkService } from '../ToolRuntime/ToolContextServices'
import { AgentEvents, type AgentEventsService, type TartEvent } from './AgentEventsService'

/** Live AgentEvents layer backed by an unbounded, live-only PubSub of ephemeral events. */
export const liveAgentEventsLayer: Layer.Layer<AgentEvents> = Layer.effect(
	AgentEvents,
	Effect.gen(function* () {
		const pubsub = yield* PubSub.unbounded<TartEvent>()

		const service: AgentEventsService = {
			publish: Effect.fn('tart.agent_events.publish')((event) =>
				PubSub.publish(pubsub, event).pipe(Effect.asVoid),
			),
			subscribe: Stream.fromPubSub(pubsub),
		}

		return service
	}),
)

/**
 * Provide ToolEventSink by republishing each ToolRuntime progress event as an AgentEvents `tool-progress`
 * delta. This is the seam that lifts ephemeral tool progress into the merged session event stream, keeping
 * ToolRuntime unaware of AgentEvents.
 */
export const toolEventSinkLayerFromAgentEvents: Layer.Layer<ToolEventSink, never, AgentEvents> = Layer.effect(
	ToolEventSink,
	Effect.gen(function* () {
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
	}),
)
