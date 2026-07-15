import { makeBrandedId } from '@humanlayer/effect-branded-id'
import { Context, Effect, Layer } from 'effect'

/** ID for an agent. */
export const AgentId = makeBrandedId('agent', { brand: 'AgentId' })
export type AgentId = typeof AgentId.Type

/** ID for a compaction event. */
export const CompactionId = makeBrandedId('compaction', { brand: 'CompactionId' })
export type CompactionId = typeof CompactionId.Type

/** ID for a user, assistant, system, or tool message. */
export const MessageId = makeBrandedId('msg', { brand: 'MessageId' })
export type MessageId = typeof MessageId.Type

/** ID for a session. */
export const SessionId = makeBrandedId('sess', { brand: 'SessionId' })
export type SessionId = typeof SessionId.Type

/** ID for a state update. */
export const StateId = makeBrandedId('state', { brand: 'StateId' })
export type StateId = typeof StateId.Type

/** ID for a tool call. */
export const ToolCallId = makeBrandedId('tool_call', { brand: 'ToolCallId' })
export type ToolCallId = typeof ToolCallId.Type

export type IdsService = {
	readonly makeAgentId: Effect.Effect<AgentId>
	readonly makeCompactionId: Effect.Effect<CompactionId>
	readonly makeMessageId: Effect.Effect<MessageId>
	readonly makeSessionId: Effect.Effect<SessionId>
	readonly makeStateId: Effect.Effect<StateId>
	readonly makeToolCallId: Effect.Effect<ToolCallId>
}

export class Ids extends Context.Service<Ids, IdsService>()('Ids') {}

export const makeAgentId = Ids.pipe(Effect.flatMap((ids) => ids.makeAgentId))
export const makeCompactionId = Ids.pipe(Effect.flatMap((ids) => ids.makeCompactionId))
export const makeMessageId = Ids.pipe(Effect.flatMap((ids) => ids.makeMessageId))
export const makeSessionId = Ids.pipe(Effect.flatMap((ids) => ids.makeSessionId))
export const makeStateId = Ids.pipe(Effect.flatMap((ids) => ids.makeStateId))
export const makeToolCallId = Ids.pipe(Effect.flatMap((ids) => ids.makeToolCallId))

export const layerLiveIdFactory: Layer.Layer<Ids> = Layer.succeed(Ids, {
	makeAgentId: Effect.sync(() => AgentId.create()),
	makeCompactionId: Effect.sync(() => CompactionId.create()),
	makeMessageId: Effect.sync(() => MessageId.create()),
	makeSessionId: Effect.sync(() => SessionId.create()),
	makeStateId: Effect.sync(() => StateId.create()),
	makeToolCallId: Effect.sync(() => ToolCallId.create()),
})
