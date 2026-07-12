import {
	defaultCompactionPrompt,
	type AgentFinishedOutcome,
	type AgentId,
	LogEntry,
	LogSeq,
	type TartEvent,
} from '@humanlayer/tart-core'
import { Match, Schema } from 'effect'

export const TransientContent = Schema.Struct({
	key: Schema.String,
	kind: Schema.Literals(['text', 'reasoning']),
	text: Schema.String,
}).annotate({ identifier: 'TuiTransientContent' })
export type TransientContent = typeof TransientContent.Type

export const ReplayState = Schema.Union([
	Schema.TaggedStruct('replaying', { head: LogSeq }),
	Schema.TaggedStruct('ready', { head: Schema.NullOr(LogSeq) }),
]).annotate({ identifier: 'TuiReplayState', discriminator: '_tag' })
export type ReplayState = typeof ReplayState.Type

export const SessionState = Schema.Struct({
	seenSeqs: Schema.Array(LogSeq),
	durableHead: Schema.NullOr(LogSeq),
	rootContent: Schema.Array(LogEntry),
	interruptedAssistantSeqs: Schema.Array(LogSeq),
	transientContent: Schema.Array(TransientContent),
	replay: ReplayState,
	status: Schema.Literals(['RUNNING', 'IDLE', 'STOPPED']),
	model: Schema.String,
}).annotate({ identifier: 'TuiSessionState' })
export type SessionState = typeof SessionState.Type

export const ConversationRow = Schema.Struct({
	key: Schema.String,
	seq: Schema.NullOr(LogSeq),
	kind: Schema.Literals(['user', 'assistant', 'reasoning', 'tool-call', 'tool-result', 'compaction', 'error']),
	label: Schema.String,
	text: Schema.String,
	inputText: Schema.NullOr(Schema.String),
	executedInputText: Schema.NullOr(Schema.String),
	resultText: Schema.NullOr(Schema.String),
	toolName: Schema.NullOr(Schema.String),
	toolCallId: Schema.NullOr(Schema.String),
	status: Schema.Literals(['none', 'running', 'done', 'error', 'partial', 'interrupted']),
	isFailure: Schema.Boolean,
}).annotate({ identifier: 'TuiConversationRow' })
export type ConversationRow = typeof ConversationRow.Type

export const makeSessionState = (durableHead: number | null): SessionState => ({
	seenSeqs: [],
	durableHead: null,
	rootContent: [],
	interruptedAssistantSeqs: [],
	transientContent: [],
	replay: durableHead === null ? { _tag: 'ready', head: null } : { _tag: 'replaying', head: durableHead },
	status: 'IDLE',
	model: 'unresolved',
})

const isRootContent = Match.type<LogEntry>().pipe(
	Match.tags({
		'user-message': () => true,
		'assistant-message': () => true,
		'tool-result': () => true,
		compaction: () => true,
		error: () => true,
		session_started: () => false,
		agent_started: () => false,
		'system-message': () => false,
		tool_state: () => false,
		'model-change': () => false,
		'thinking-change': () => false,
		'tools-change': () => false,
		'agent-finished': () => false,
	}),
	Match.exhaustive,
)

const isAssistantMessage = Match.type<LogEntry>().pipe(
	Match.tag('assistant-message', () => true),
	Match.orElse(() => false),
)

const statusAfterFinish = (outcome: AgentFinishedOutcome): SessionState['status'] =>
	outcome === 'completed' ? 'IDLE' : 'STOPPED'

const replayAfter = (replay: ReplayState, seenSeqs: ReadonlyArray<number>): ReplayState =>
	Match.value(replay).pipe(
		Match.tag('ready', () => replay),
		Match.tag('replaying', ({ head }) => (seenSeqs.includes(head) ? { _tag: 'ready' as const, head } : replay)),
		Match.exhaustive,
	)

const reduceLog = (state: SessionState, entry: LogEntry, rootAgentId: AgentId): SessionState => {
	if (state.seenSeqs.includes(entry.seq)) return state

	const durableHead = Math.max(state.durableHead ?? entry.seq, entry.seq)
	const seenSeqs = [...state.seenSeqs, entry.seq]
	const rootEntry = entry.agentId === rootAgentId && isRootContent(entry)
	const rootContent = rootEntry
		? [...state.rootContent, entry].sort((left, right) => left.seq - right.seq)
		: state.rootContent

	const projection =
		entry.agentId === rootAgentId
			? Match.value(entry).pipe(
					Match.tags({
						agent_started: ({ model }) => ({ status: 'IDLE' as const, model: model.modelId }),
						'model-change': ({ model }) => ({ status: state.status, model: model.modelId }),
						'user-message': () => ({ status: 'RUNNING' as const, model: state.model }),
						'agent-finished': ({ outcome }) => ({
							status: statusAfterFinish(outcome),
							model: state.model,
						}),
					}),
					Match.orElse(() => ({ status: state.status, model: state.model })),
				)
			: { status: state.status, model: state.model }
	const latestUserSeq = state.rootContent.filter((candidate) => candidate._tag === 'user-message').at(-1)?.seq ?? -1
	const interruptedAssistantSeqs =
		entry.agentId === rootAgentId && entry._tag === 'agent-finished' && entry.outcome === 'interrupted'
			? [
					...state.interruptedAssistantSeqs,
					...state.rootContent
						.filter(
							(candidate) =>
								candidate._tag === 'assistant-message' &&
								candidate.finish === null &&
								candidate.seq > latestUserSeq,
						)
						.slice(-1)
						.map(({ seq }) => seq),
				]
			: state.interruptedAssistantSeqs

	return {
		...state,
		seenSeqs,
		durableHead,
		rootContent,
		interruptedAssistantSeqs,
		transientContent:
			(rootEntry && isAssistantMessage(entry)) ||
			(entry.agentId === rootAgentId && entry._tag === 'agent-finished')
				? []
				: state.transientContent,
		replay: replayAfter(state.replay, seenSeqs),
		...projection,
	}
}

const appendTransient = (
	state: SessionState,
	kind: TransientContent['kind'],
	id: string,
	delta: string,
): SessionState => {
	const key = `${kind}:${id}`
	const existing = state.transientContent.find((content) => content.key === key)
	const transientContent =
		existing === undefined
			? [...state.transientContent, { key, kind, text: delta }]
			: state.transientContent.map((content) =>
					content.key === key ? { ...content, text: content.text + delta } : content,
				)
	return { ...state, transientContent }
}

export const reduceSessionEvent = (state: SessionState, event: TartEvent, rootAgentId: AgentId): SessionState => {
	if (event.kind === 'log') return reduceLog(state, event.entry, rootAgentId)
	if (event.agentId !== rootAgentId) return state

	switch (event.part.type) {
		case 'text-delta':
			return { ...appendTransient(state, 'text', event.part.id, event.part.delta), status: 'RUNNING' }
		case 'reasoning-delta':
			return { ...appendTransient(state, 'reasoning', event.part.id, event.part.delta), status: 'RUNNING' }
		case 'tool-progress':
			return state
	}
}

export const reduceSessionEvents = (
	state: SessionState,
	events: ReadonlyArray<TartEvent>,
	rootAgentId: AgentId,
): SessionState => events.reduce((next, event) => reduceSessionEvent(next, event, rootAgentId), state)

export const makeSessionStateFromEntries = (entries: ReadonlyArray<LogEntry>, rootAgentId: AgentId): SessionState =>
	reduceSessionEvents(
		makeSessionState(null),
		entries.map((entry) => ({ kind: 'log' as const, entry })),
		rootAgentId,
	)

const clippedText = (text: string): string => {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length <= 180 ? flat : `${flat.slice(0, 179)}…`
}

const clippedSummary = (value: unknown): string => {
	const encoded = JSON.stringify(value)
	return encoded === undefined ? '' : clippedText(encoded)
}

const prettyJson = (value: unknown): string => {
	const encoded = JSON.stringify(value, null, 2)
	return encoded === undefined ? '' : encoded
}

const contentPartText = (part: unknown): string => {
	if (typeof part !== 'object' || part === null || !('type' in part)) return prettyJson(part)
	if (part.type === 'text' && 'text' in part && typeof part.text === 'string') return part.text
	if (part.type === 'image') return '[image content]'
	return prettyJson(part)
}

const toolInputDetail = (params: unknown): string => prettyJson(params)

const toolCallSummary = (params: unknown): string => {
	if (typeof params !== 'object' || params === null) return clippedSummary(params)
	if ('command' in params && typeof params.command === 'string') return clippedText(params.command)
	if ('path' in params && typeof params.path === 'string') return clippedText(params.path)
	if ('description' in params && typeof params.description === 'string') return clippedText(params.description)
	return clippedSummary(params)
}

const toolResultSummary = (result: unknown): string => {
	if (typeof result === 'string') return clippedText(result)
	if (typeof result === 'object' && result !== null && 'output' in result && typeof result.output === 'string') {
		return clippedText(result.output)
	}
	return clippedSummary(result)
}

const toolResultDetail = (result: unknown): string => {
	if (typeof result === 'string') return result
	if (typeof result !== 'object' || result === null) return prettyJson(result)
	if ('output' in result && typeof result.output === 'string') return result.output
	if ('message' in result && typeof result.message === 'string') return result.message
	if ('content' in result && typeof result.content === 'string') return result.content
	if ('content' in result && Array.isArray(result.content)) return result.content.map(contentPartText).join('\n')
	return prettyJson(result)
}

const sameText = (left: string | null, right: string | null): boolean => left === right

const interruptedToolResultPrefix = '<system-information>The user interrupted the execution of this tool call.'

const rowsForEntry = (
	entry: LogEntry,
	interruptedAssistantSeqs: ReadonlyArray<number>,
): ReadonlyArray<ConversationRow> =>
	Match.value(entry).pipe(
		Match.tags({
			'user-message': ({ message, messageId, seq }): ReadonlyArray<ConversationRow> => {
				const text =
					typeof message.content === 'string'
						? message.content
						: message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
				return text.length === 0
					? []
					: [
							{
								key: messageId,
								seq,
								kind: 'user',
								label: 'USER',
								text,
								inputText: null,
								executedInputText: null,
								resultText: null,
								toolName: null,
								toolCallId: null,
								status: 'none' as const,
								isFailure: false,
							},
						]
			},
			'assistant-message': ({ message, messageId, seq }) => {
				const partial = interruptedAssistantSeqs.includes(seq)
				if (typeof message.content === 'string') {
					return message.content.length === 0
						? []
						: [
								{
									key: messageId,
									seq,
									kind: 'assistant' as const,
									label: partial ? 'PARTIAL' : 'ASSISTANT',
									text: message.content,
									inputText: null,
									executedInputText: null,
									resultText: null,
									toolName: null,
									toolCallId: null,
									status: partial ? ('partial' as const) : ('none' as const),
									isFailure: false,
								},
							]
				}

				return message.content.flatMap((part, index): ReadonlyArray<ConversationRow> => {
					switch (part.type) {
						case 'text':
							return part.text.length === 0
								? []
								: [
										{
											key: `${messageId}:text:${index}`,
											seq,
											kind: 'assistant',
											label: partial ? 'PARTIAL' : 'ASSISTANT',
											text: part.text,
											inputText: null,
											executedInputText: null,
											resultText: null,
											toolName: null,
											toolCallId: null,
											status: partial ? ('partial' as const) : ('none' as const),
											isFailure: false,
										},
									]
						case 'reasoning':
							return part.text.length === 0
								? []
								: [
										{
											key: `${messageId}:reasoning:${index}`,
											seq,
											kind: 'reasoning',
											label: 'THINKING',
											text: part.text,
											inputText: null,
											executedInputText: null,
											resultText: null,
											toolName: null,
											toolCallId: null,
											status: 'none' as const,
											isFailure: false,
										},
									]
						case 'tool-call':
							return [
								{
									key: `${messageId}:tool:${part.id}`,
									seq,
									kind: 'tool-call',
									label: part.name.toUpperCase(),
									text: toolCallSummary(part.params),
									inputText: toolInputDetail(part.params),
									executedInputText: null,
									resultText: null,
									toolName: part.name,
									toolCallId: part.id,
									status: 'running' as const,
									isFailure: false,
								},
							]
						default:
							return []
					}
				})
			},
			'tool-result': ({ executedInput, message, messageId, seq }) =>
				typeof message.content === 'string'
					? []
					: message.content.flatMap(
							(part, index): ReadonlyArray<ConversationRow> =>
								part.type === 'tool-result'
									? [
											{
												key: `${messageId}:result:${index}`,
												seq,
												kind: 'tool-result',
												label: part.isFailure ? 'FAILED' : 'RESULT',
												text: toolResultSummary(part.result),
												inputText: null,
												executedInputText:
													executedInput === undefined ? null : toolInputDetail(executedInput),
												resultText: toolResultDetail(part.result),
												toolName: part.name,
												toolCallId: part.id,
												status:
													part.isFailure &&
													toolResultDetail(part.result).startsWith(
														interruptedToolResultPrefix,
													)
														? 'interrupted'
														: part.isFailure
															? 'error'
															: 'done',
												isFailure: part.isFailure,
											},
										]
									: [],
						),
			compaction: ({
				compactionId,
				postCompactionInstructions,
				prompt,
				seq,
				summary,
			}): ReadonlyArray<ConversationRow> => [
				{
					key: compactionId,
					seq,
					kind: 'compaction',
					label: 'COMPACT',
					text: summary,
					inputText: prompt ?? defaultCompactionPrompt,
					executedInputText: postCompactionInstructions ?? null,
					resultText: summary,
					toolName: null,
					toolCallId: null,
					status: 'none' as const,
					isFailure: false,
				},
			],
			error: ({ seq, errorType, message }): ReadonlyArray<ConversationRow> => [
				{
					key: `error:${seq}`,
					seq,
					kind: 'error',
					label: errorType.toUpperCase(),
					text: message,
					inputText: null,
					executedInputText: null,
					resultText: null,
					toolName: null,
					toolCallId: null,
					status: 'none' as const,
					isFailure: true,
				},
			],
		}),
		Match.orElse(() => []),
	)

const collapseToolResults = (rows: ReadonlyArray<ConversationRow>): ReadonlyArray<ConversationRow> => {
	const visible: ConversationRow[] = []
	const toolCallIndexes = new Map<string, number>()

	for (const row of rows) {
		if (row.kind === 'tool-call' && row.toolCallId !== null) {
			toolCallIndexes.set(row.toolCallId, visible.length)
			visible.push(row)
			continue
		}

		if (row.kind === 'tool-result') {
			const index = row.toolCallId === null ? undefined : toolCallIndexes.get(row.toolCallId)
			if (index !== undefined) {
				const toolCall = visible[index]
				if (toolCall !== undefined) {
					visible[index] = {
						...toolCall,
						status: row.status,
						isFailure: row.isFailure,
						executedInputText: sameText(toolCall.inputText, row.executedInputText)
							? null
							: row.executedInputText,
						resultText: row.resultText,
					}
				}
			}
			continue
		}

		visible.push(row)
	}

	return visible
}

export const conversationRows = (state: SessionState): ReadonlyArray<ConversationRow> => [
	...collapseToolResults(state.rootContent.flatMap((entry) => rowsForEntry(entry, state.interruptedAssistantSeqs))),
	...state.transientContent.map(
		(content): ConversationRow => ({
			key: `transient:${content.key}`,
			seq: null,
			kind: content.kind === 'text' ? 'assistant' : 'reasoning',
			label: content.kind === 'text' ? 'ASSISTANT' : 'THINKING',
			text: content.text,
			inputText: null,
			executedInputText: null,
			resultText: null,
			toolName: null,
			toolCallId: null,
			status: 'none',
			isFailure: false,
		}),
	),
]

export const replayIsReady = Match.type<ReplayState>().pipe(
	Match.tag('ready', () => true),
	Match.tag('replaying', () => false),
	Match.exhaustive,
)
