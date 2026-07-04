/**
 * This file builds the per-tool-call ToolState service that handlers receive while they run. ToolRuntime
 * consumes this factory for each prepared tool call, the resulting service reads historical state from
 * EventLog projections, and writes new state entries back through EventLog using Ids for durable ids.
 */
import { Effect, Stream } from 'effect'

import { EventLog } from '../EventLog/EventLogService'
import type { LogEntry } from '../EventLog/Schemas'
import { Ids, type AgentId, type ToolCallId } from '../Ids'
import { toolStateForAgent } from '../Projection/Projection'
import type { ToolStateService } from './ToolStateService'

/** Collect every persisted event so ToolState reads can derive the latest value from projections. */
const collectEventLogEntries = Effect.fn('tart.tool_state.collect_entries')(
	(entries: Stream.Stream<LogEntry, unknown>) =>
		Stream.runCollect(entries).pipe(
			Effect.orDie,
			Effect.map((entries): ReadonlyArray<LogEntry> => entries),
		),
)

/** Build the ToolState service scoped to one agent, one tool call, and one namespace. */
export const toolStateServiceForToolCall = (input: {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId
	readonly namespace: string
}): Effect.Effect<ToolStateService, never, EventLog | Ids> =>
	Effect.gen(function* () {
		const eventLog = yield* EventLog
		const ids = yield* Ids

		return {
			/** Read the latest projected value for one key in this call's namespace. */
			get: Effect.fn('tart.tool_state.get')((key) =>
				Effect.gen(function* () {
					const entries = yield* collectEventLogEntries(eventLog.entries())
					const state = toolStateForAgent(entries, input.agentId, input.namespace)

					return state[key] ?? null
				}).pipe(
					Effect.withSpan('tart.tool_state.get', {
						attributes: {
							agentId: input.agentId,
							toolCallId: input.toolCallId,
							namespace: input.namespace,
							key,
						},
					}),
				),
			),

			/** Persist one new value for one key in this call's namespace. */
			set: Effect.fn('tart.tool_state.set')((key, value) =>
				ids.makeStateId.pipe(
					Effect.flatMap((stateId) =>
						eventLog.append({
							_tag: 'tool_state',
							agentId: input.agentId,
							parentAgentId: input.parentAgentId,
							toolCallId: input.toolCallId,
							namespace: input.namespace,
							stateId,
							key,
							value,
						}),
					),
					Effect.orDie,
					Effect.asVoid,
					Effect.withSpan('tart.tool_state.set', {
						attributes: {
							agentId: input.agentId,
							toolCallId: input.toolCallId,
							namespace: input.namespace,
							key,
						},
					}),
				),
			),
		}
	})
