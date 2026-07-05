/**
 * This file builds the ToolState services that hooks and tool handlers receive while they run. Hooks get
 * the live variant whose reads re-derive from the full EventLog on every call (hook chains run
 * sequentially, so live reads are race-free). Tool handlers get the snapshot variant: reads see the log
 * as of the handler fork point plus the call's own writes, so parallel sibling calls cannot leak
 * mid-batch state into each other. Both variants append durable tool_state entries immediately.
 */
import { Effect, Ref, Stream } from 'effect'

import { EventLog, type EventLogService } from '../EventLog/EventLogService'
import type { LogEntry } from '../EventLog/Schemas'
import { Ids, type AgentId, type IdsService, type ToolCallId } from '../Ids'
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

type ToolStateScope = {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId | null
}

/** Build the durable tool_state appender shared by both ToolState variants. */
const appendToolStateEntry = (
	scope: ToolStateScope,
	eventLog: EventLogService,
	ids: IdsService,
): ToolStateService['set'] =>
	Effect.fn('tart.tool_state.set')((namespace, key, value) =>
		ids.makeStateId.pipe(
			Effect.flatMap((stateId) =>
				eventLog.append({
					_tag: 'tool_state',
					agentId: scope.agentId,
					parentAgentId: scope.parentAgentId,
					toolCallId: scope.toolCallId,
					namespace,
					stateId,
					key,
					value,
				}),
			),
			Effect.orDie,
			Effect.asVoid,
			Effect.withSpan('tart.tool_state.set', {
				attributes: {
					agentId: scope.agentId,
					toolCallId: scope.toolCallId ?? 'none',
					namespace,
					key,
				},
			}),
		),
	)

/**
 * Build the live ToolState service scoped to one agent and one tool call. Reads re-derive from the full
 * EventLog on every call, using the namespace supplied per operation. Used for hook chains, which run
 * sequentially; toolCallId is null when a hook writes outside a tool call.
 */
export const toolStateServiceForToolCall = (
	input: ToolStateScope,
): Effect.Effect<ToolStateService, never, EventLog | Ids> =>
	Effect.gen(function* () {
		const eventLog = yield* EventLog
		const ids = yield* Ids

		return {
			/** Read the latest projected value for one key in the given namespace from the live log. */
			get: Effect.fn('tart.tool_state.get')((namespace, key) =>
				Effect.gen(function* () {
					const entries = yield* collectEventLogEntries(eventLog.entries())
					const state = toolStateForAgent(entries, input.agentId, namespace)

					return state[key] ?? null
				}).pipe(
					Effect.withSpan('tart.tool_state.get', {
						attributes: {
							agentId: input.agentId,
							toolCallId: input.toolCallId ?? 'none',
							namespace,
							key,
						},
					}),
				),
			),

			set: appendToolStateEntry(input, eventLog, ids),
		}
	})

/**
 * Build the snapshot ToolState service for one tool handler. Reads see the state folded from the given
 * snapshot (the log as of the handler fork point, after preToolUse chains) plus this call's own writes,
 * both resolved against the namespace supplied per operation; writes made by concurrently running sibling
 * calls stay invisible until the next batch. Writes are still appended to the EventLog immediately - they
 * are durable facts even if this call is later interrupted.
 */
export const toolStateServiceForHandler = (input: {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId
	readonly snapshot: ReadonlyArray<LogEntry>
}): Effect.Effect<ToolStateService, never, EventLog | Ids> =>
	Effect.gen(function* () {
		const eventLog = yield* EventLog
		const ids = yield* Ids
		const ownWrites = yield* Ref.make<
			ReadonlyArray<{ readonly namespace: string; readonly key: string; readonly value: unknown }>
		>([])
		const appendDurable = appendToolStateEntry(input, eventLog, ids)

		return {
			/** Read one key from the fork-point snapshot overlaid with this call's own writes. */
			get: Effect.fn('tart.tool_state.get')((namespace, key) =>
				Ref.get(ownWrites).pipe(
					Effect.map((writes) => {
						const ownWrite = writes.findLast((write) => write.namespace === namespace && write.key === key)
						if (ownWrite !== undefined) return ownWrite.value

						return toolStateForAgent(input.snapshot, input.agentId, namespace)[key] ?? null
					}),
					Effect.withSpan('tart.tool_state.get', {
						attributes: {
							agentId: input.agentId,
							toolCallId: input.toolCallId,
							namespace,
							key,
							snapshot: true,
						},
					}),
				),
			),

			/** Persist one value durably and record it in this call's own-writes overlay. */
			set: Effect.fn('tart.tool_state.set')((namespace, key, value) =>
				appendDurable(namespace, key, value).pipe(
					Effect.flatMap(() => Ref.update(ownWrites, (writes) => [...writes, { namespace, key, value }])),
				),
			),
		}
	})
