import { makeBrandedId } from '@humanlayer/effect-branded-id'

/** ID for an agent  */
export const AgentId = makeBrandedId('agent', {brand: 'AgentId'})
export type AgentId = typeof AgentId.Type

/** ID for a compaction event */
export const CompactionId = makeBrandedId('compaction', { brand: 'CompactionId'})
export type CompactionId = typeof CompactionId.Type

/** ID for a user / assistantmessage */
export const MessageId = makeBrandedId('msg', {brand: 'MessageId'})
export type MessageId = typeof MessageId.Type

/** ID for a session */
export const SessionId = makeBrandedId('sess', { brand: 'SessionId'})
export type SessionId = typeof SessionId.Type
/** ID for a State update */
export const StateId = makeBrandedId('state', { brand: 'StateId'})
export type StateId = typeof StateId.Type
/** ID For a tool call */
export const ToolCallId = makeBrandedId('tool_call', { brand: 'ToolCallId'})
export type ToolCallId = typeof ToolCallId.Type
