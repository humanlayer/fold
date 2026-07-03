import type {
	ActiveModel,
	AgentFinishedLogEntry,
	AgentStartedLogEntry,
	AssistantMessageEncoded,
	AssistantMessageLogEntry,
	CompactionLogEntry,
	LogEntry,
	ReasoningLevel,
	SystemMessageLogEntry,
	ToolMessageEncoded,
	ToolResultLogEntry,
	UserMessageLogEntry,
} from '../EventLog/Schemas.ts'
import type { AgentId } from '../Ids.ts'

/** Read model for an agent's lifecycle: how it started, whether it has finished, and whether it is runnable. */
export type AgentLifecycleProjection = {
	readonly agentId: AgentId
	readonly started: AgentStartedLogEntry | null
	readonly finished: AgentFinishedLogEntry | null
	readonly isRunning: boolean
	readonly isFinished: boolean
}

/** Read model for the runtime policy an agent should use on its next turn. */
export type AgentRuntimeProjection = AgentLifecycleProjection & {
	readonly activeModel: ActiveModel | null
	readonly activeTools: ReadonlyArray<string>
	readonly reasoningLevel: ReasoningLevel | null
}

/** Helper for projected records that keep the durable entry discriminant and selected payload fields. */
type ProjectedLogEntry<Entry extends LogEntry, Keys extends keyof Entry> = Pick<Entry, '_tag' | Keys> & {
	readonly sourceSeq: Entry['seq']
}

/** Helper for projected records that are derived from a durable entry but have their own projection-only shape. */
type ProjectedLogEntryFields<Entry extends LogEntry, Keys extends keyof Entry> = Pick<Entry, Keys> & {
	readonly sourceSeq: Entry['seq']
}

/** System instruction selected for the model context, retaining its source sequence for traceability. */
export type ProjectedSystemMessage = ProjectedLogEntry<SystemMessageLogEntry, 'messageId' | 'placement' | 'message'>

/** User message that should be visible in the model context, retaining its source sequence for traceability. */
export type ProjectedUserMessage = ProjectedLogEntry<UserMessageLogEntry, 'messageId' | 'message'>

/** Assistant message that should be visible in the model context, retaining finish metadata for usage/cost folds. */
export type ProjectedAssistantMessage = ProjectedLogEntry<AssistantMessageLogEntry, 'messageId' | 'message' | 'finish'>

/** Tool result that should be visible in the model context, grouped by the tool call it answers. */
export type ProjectedToolResult = ProjectedLogEntry<ToolResultLogEntry, 'toolCallId' | 'messageId' | 'message'>

/** Projection-only stand-in for history replaced by a compaction entry. */
export type ProjectedCompactionSummary = ProjectedLogEntryFields<
	CompactionLogEntry,
	'compactionId' | 'replacesThroughSeq' | 'summary' | 'tokensBefore'
> & {
	readonly _tag: `${CompactionLogEntry['_tag']}-summary`
}

/** Ordered read model of the messages an agent should send to the language model. */
export type ProjectedMessage =
	| ProjectedSystemMessage
	| ProjectedUserMessage
	| ProjectedAssistantMessage
	| ProjectedToolResult
	| ProjectedCompactionSummary

/** Tool-owned key/value state for one agent namespace, built by folding tool_state entries in log order. */
export type ToolStateProjection = Readonly<Record<string, unknown>>

const ownEntriesForAgent = (entries: ReadonlyArray<LogEntry>, agentId: AgentId): ReadonlyArray<LogEntry> =>
	entries.filter((entry) => entry.agentId === agentId)

const findAgentStarted = (entries: ReadonlyArray<LogEntry>, agentId: AgentId): AgentStartedLogEntry | null =>
	entries.find(
		(entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started' && entry.agentId === agentId,
	) ?? null

const findAgentFinished = (entries: ReadonlyArray<LogEntry>, agentId: AgentId): AgentFinishedLogEntry | null =>
	entries.findLast(
		(entry): entry is AgentFinishedLogEntry => entry._tag === 'agent-finished' && entry.agentId === agentId,
	) ?? null

const compareSeq = (left: LogEntry, right: LogEntry) => left.seq - right.seq

const entriesForAgentInternal = (
	entries: ReadonlyArray<LogEntry>,
	agentId: AgentId,
	seen: ReadonlySet<AgentId>,
): ReadonlyArray<LogEntry> => {
	if (seen.has(agentId)) return ownEntriesForAgent(entries, agentId)

	const started = findAgentStarted(entries, agentId)
	const ownEntries = ownEntriesForAgent(entries, agentId)

	if (started === null || started.mode !== 'fork' || started.fork === null) return ownEntries

	const fork = started.fork

	const parentEntries = entriesForAgentInternal(entries, fork.fromAgentId, new Set([...seen, agentId])).filter(
		(entry) => entry.seq <= fork.atSeq,
	)

	return [...parentEntries, ...ownEntries].sort(compareSeq)
}

/**
 * Build the log slice an agent can see.
 *
 * Fresh agents see only their own entries. Forked agents see their parent's visible entries through the fork
 * sequence, followed by their own entries. This is the read model that makes fork-by-reference work without
 * copying parent history into the log.
 */
export const entriesForAgent = (entries: ReadonlyArray<LogEntry>, agentId: AgentId): ReadonlyArray<LogEntry> =>
	entriesForAgentInternal(entries, agentId, new Set())

/** Build an agent lifecycle read model from its agent_started and agent-finished entries. */
export const lifecycleForAgent = (entries: ReadonlyArray<LogEntry>, agentId: AgentId): AgentLifecycleProjection => {
	const started = findAgentStarted(entries, agentId)
	const finished = findAgentFinished(entries, agentId)

	return {
		agentId,
		started,
		finished,
		isRunning: started !== null && finished === null,
		isFinished: finished !== null,
	}
}

/** Build the active runtime policy for an agent from agent_started plus model/tool/reasoning change entries. */
export const runtimeForAgent = (entries: ReadonlyArray<LogEntry>, agentId: AgentId): AgentRuntimeProjection => {
	const visibleEntries = entriesForAgent(entries, agentId)
	let activeModel: ActiveModel | null = null
	let activeTools: ReadonlyArray<string> = []
	let reasoningLevel: ReasoningLevel | null = null

	for (const entry of visibleEntries) {
		switch (entry._tag) {
			case 'agent_started':
				activeModel = entry.model
				activeTools = entry.tools
				reasoningLevel = entry.model.reasoningLevel
				break
			case 'model-change':
				activeModel = entry.model
				reasoningLevel = entry.model.reasoningLevel
				break
			case 'thinking-change':
				reasoningLevel = entry.reasoningLevel
				break
			case 'tools-change':
				activeTools = entry.tools
				break
		}
	}

	return {
		...lifecycleForAgent(entries, agentId),
		activeModel,
		activeTools,
		reasoningLevel,
	}
}

/** Build tool KV state for an agent namespace by applying tool_state set/delete entries in log order. */
export const toolStateForAgent = (
	entries: ReadonlyArray<LogEntry>,
	agentId: AgentId,
	namespace: string,
): ToolStateProjection => {
	const state: Record<string, unknown> = {}

	for (const entry of ownEntriesForAgent(entries, agentId)) {
		if (entry._tag !== 'tool_state' || entry.namespace !== namespace) continue

		if (entry.value === null) {
			delete state[entry.key]
		} else {
			state[entry.key] = entry.value
		}
	}

	return state
}

const latestLeadingSystemMessage = (entries: ReadonlyArray<LogEntry>): SystemMessageLogEntry | null =>
	entries.findLast(
		(entry): entry is SystemMessageLogEntry => entry._tag === 'system-message' && entry.placement === 'leading',
	) ?? null

const latestCompaction = (entries: ReadonlyArray<LogEntry>): CompactionLogEntry | null =>
	entries.findLast((entry): entry is CompactionLogEntry => entry._tag === 'compaction') ?? null

const toolCallIdsForAssistantMessage = (message: AssistantMessageEncoded): ReadonlyArray<string> => {
	if (typeof message.content === 'string') return []

	return message.content.flatMap((part) => (part.type === 'tool-call' ? [part.id] : []))
}

const toolResultIds = (message: ToolMessageEncoded): ReadonlyArray<string> =>
	message.content.flatMap((part) => (part.type === 'tool-result' ? [part.id] : []))

/** Put completed tool results back into the assistant's tool-call order before building the next prompt. */
const orderProjectedToolResults = (messages: ReadonlyArray<ProjectedMessage>): ReadonlyArray<ProjectedMessage> => {
	const ordered: Array<ProjectedMessage> = []
	let index = 0

	while (index < messages.length) {
		const message = messages[index]
		if (message === undefined) break

		ordered.push(message)
		index += 1

		if (message._tag !== 'assistant-message') continue

		const toolCallIds = toolCallIdsForAssistantMessage(message.message)
		if (toolCallIds.length === 0) continue

		const toolResults: Array<ProjectedToolResult> = []
		while (true) {
			const toolResult = messages[index]
			if (toolResult?._tag !== 'tool-result') break

			toolResults.push(toolResult)
			index += 1
		}

		const resultOrder = new Map(toolCallIds.map((toolCallId, order) => [toolCallId, order]))
		ordered.push(
			...toolResults.sort((left, right) => {
				const leftOrder = Math.min(
					...toolResultIds(left.message).map((id) => resultOrder.get(id) ?? Number.MAX_SAFE_INTEGER),
				)
				const rightOrder = Math.min(
					...toolResultIds(right.message).map((id) => resultOrder.get(id) ?? Number.MAX_SAFE_INTEGER),
				)

				return leftOrder === rightOrder ? left.sourceSeq - right.sourceSeq : leftOrder - rightOrder
			}),
		)
	}

	return ordered
}

/** Translate one durable message entry into the projection shape used by prompt construction. */
const projectMessageEntry = (entry: LogEntry): ProjectedMessage | null => {
	switch (entry._tag) {
		case 'system-message':
			return {
				_tag: 'system-message',
				sourceSeq: entry.seq,
				messageId: entry.messageId,
				placement: entry.placement,
				message: entry.message,
			}
		case 'user-message':
			return { _tag: 'user-message', sourceSeq: entry.seq, messageId: entry.messageId, message: entry.message }
		case 'assistant-message':
			return {
				_tag: 'assistant-message',
				sourceSeq: entry.seq,
				messageId: entry.messageId,
				message: entry.message,
				finish: entry.finish,
			}
		case 'tool-result':
			return {
				_tag: 'tool-result',
				sourceSeq: entry.seq,
				toolCallId: entry.toolCallId,
				messageId: entry.messageId,
				message: entry.message,
			}
	}

	return null
}

/**
 * Build the conversation read model for an agent.
 *
 * This is the prompt-building source of truth: it starts from the agent's visible log slice, keeps only the latest
 * leading system message, inserts the latest compaction summary as a projection-only message, drops entries replaced
 * by compaction, and orders tool results the way the model expects to see them.
 */
export const messagesForAgent = (
	entries: ReadonlyArray<LogEntry>,
	agentId: AgentId,
): ReadonlyArray<ProjectedMessage> => {
	const visibleEntries = entriesForAgent(entries, agentId)
	const leading = latestLeadingSystemMessage(visibleEntries)
	const compaction = latestCompaction(visibleEntries)
	const cutSeq = compaction?.replacesThroughSeq ?? -1
	const projected: Array<ProjectedMessage> = []

	if (leading !== null) {
		projected.push({
			_tag: 'system-message',
			sourceSeq: leading.seq,
			messageId: leading.messageId,
			placement: leading.placement,
			message: leading.message,
		})
	}

	if (compaction !== null) {
		projected.push({
			_tag: 'compaction-summary',
			sourceSeq: compaction.seq,
			compactionId: compaction.compactionId,
			replacesThroughSeq: compaction.replacesThroughSeq,
			summary: compaction.summary,
			tokensBefore: compaction.tokensBefore,
		})
	}

	for (const entry of visibleEntries) {
		if (entry.seq <= cutSeq) continue
		if (entry._tag === 'system-message' && entry.placement === 'leading') continue

		const message = projectMessageEntry(entry)
		if (message !== null) projected.push(message)
	}

	return orderProjectedToolResults(projected)
}
