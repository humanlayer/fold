import { Schema } from 'effect'
import { Prompt, Response } from 'effect/unstable/ai'

import { AgentId, CompactionId, MessageId, SessionId, StateId, ToolCallId } from '../Ids'

/** The sequence number of a log entry. The first entry in a session is seq 0. */
export const LogSeq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
	identifier: 'LogSeq',
})
export type LogSeq = typeof LogSeq.Type

/** Schema for epoch milliseconds. */
export const EpochMillis = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
	identifier: 'EpochMillis',
})
export type EpochMillis = typeof EpochMillis.Type

/** The durable log format version written in the first session entry. */
export const LogVersion = Schema.Literal(1)
export type LogVersion = typeof LogVersion.Type

/** A configured provider profile id, not a secret or API key. */
export const LlmProviderId = Schema.String.annotate({ identifier: 'LlmProviderId' })
export type LlmProviderId = typeof LlmProviderId.Type

/** The provider family used by request projection and provider-specific rendering. */
export const LlmProviderKind = Schema.Literals(['anthropic', 'openai-compatible', 'codex']).annotate({
	identifier: 'LlmProviderKind',
})
export type LlmProviderKind = typeof LlmProviderKind.Type

/** The provider model id string sent to the provider. */
export const LlmModelId = Schema.String.annotate({ identifier: 'LlmModelId' })
export type LlmModelId = typeof LlmModelId.Type

/** Model roles are resolved to concrete models before being persisted. */
export const ModelRole = Schema.Literals(['inherit', 'orchestrator', 'smart', 'fast']).annotate({
	identifier: 'ModelRole',
})
export type ModelRole = typeof ModelRole.Type

/** Canonical reasoning level vocabulary for provider request options. */
export const ReasoningLevel = Schema.Literals(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).annotate({
	identifier: 'ReasoningLevel',
})
export type ReasoningLevel = typeof ReasoningLevel.Type

/**
 * OpenAI Responses API reasoning effort after catalog validation/mapping. The full wire scale,
 * including `max` (gpt-5.6 family); which levels a given model actually supports is catalog data
 * validated at the AgentModels seam (D23/D25), not narrowed here.
 */
export const OpenAiReasoningEffort = Schema.Literals([
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
]).annotate({
	identifier: 'OpenAiReasoningEffort',
})
export type OpenAiReasoningEffort = typeof OpenAiReasoningEffort.Type

/** OpenAI-compatible reasoning settings after catalog validation/mapping. */
export const OpenAiReasoningSetting = Schema.Union([
	Schema.TaggedStruct('disabled', {}),
	Schema.TaggedStruct('effort', { effort: OpenAiReasoningEffort }),
]).annotate({ identifier: 'OpenAiReasoningSetting', discriminator: '_tag' })
export type OpenAiReasoningSetting = typeof OpenAiReasoningSetting.Type

/** Codex reasoning settings after catalog validation/mapping. */
export const CodexReasoningSetting = Schema.Union([
	Schema.TaggedStruct('disabled', {}),
	Schema.TaggedStruct('effort', {
		effort: OpenAiReasoningEffort,
		summary: Schema.Literal('auto'),
	}),
]).annotate({ identifier: 'CodexReasoningSetting', discriminator: '_tag' })
export type CodexReasoningSetting = typeof CodexReasoningSetting.Type

/**
 * Anthropic thinking settings after catalog validation/mapping. `adaptive` is the default for models
 * that support it (Opus 4.6+, Sonnet 4.6+, Fable/Mythos) - the model decides when and how much to
 * think, with depth steered per-request via effort. `budget` remains for pre-adaptive models
 * (Haiku 4.5, Sonnet 4.5, and older), where a fixed token budget is the only thinking mechanism.
 */
export const AnthropicThinkingSetting = Schema.Union([
	Schema.TaggedStruct('disabled', {}),
	Schema.TaggedStruct('adaptive', {}),
	Schema.TaggedStruct('budget', {
		budgetTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1024)),
	}),
]).annotate({ identifier: 'AnthropicThinkingSetting', discriminator: '_tag' })
export type AnthropicThinkingSetting = typeof AnthropicThinkingSetting.Type

/** A safe, resolved OpenAI-compatible model snapshot. Credentials and base URLs stay in config/auth services. */
export const OpenAiCompatibleActiveModel = Schema.Struct({
	providerId: LlmProviderId,
	providerKind: Schema.Literal('openai-compatible'),
	modelId: LlmModelId,
	role: Schema.NullOr(ModelRole),
	requestedReasoningLevel: ReasoningLevel,
	reasoning: OpenAiReasoningSetting,
}).annotate({ identifier: 'OpenAiCompatibleActiveModel' })
export type OpenAiCompatibleActiveModel = typeof OpenAiCompatibleActiveModel.Type

/** A safe, resolved Anthropic model snapshot. Credentials and base URLs stay in config/auth services. */
export const AnthropicActiveModel = Schema.Struct({
	providerId: LlmProviderId,
	providerKind: Schema.Literal('anthropic'),
	modelId: LlmModelId,
	role: Schema.NullOr(ModelRole),
	requestedReasoningLevel: ReasoningLevel,
	thinking: AnthropicThinkingSetting,
}).annotate({ identifier: 'AnthropicActiveModel' })
export type AnthropicActiveModel = typeof AnthropicActiveModel.Type

/** A safe, resolved Codex model snapshot. Credentials and base URLs stay in config/auth services. */
export const CodexActiveModel = Schema.Struct({
	providerId: LlmProviderId,
	providerKind: Schema.Literal('codex'),
	modelId: LlmModelId,
	role: Schema.NullOr(ModelRole),
	requestedReasoningLevel: ReasoningLevel,
	reasoning: CodexReasoningSetting,
}).annotate({ identifier: 'CodexActiveModel' })
export type CodexActiveModel = typeof CodexActiveModel.Type

/** A safe, resolved model snapshot. Credentials and base URLs stay in config/auth services. */
export const ActiveModel = Schema.Union([OpenAiCompatibleActiveModel, AnthropicActiveModel, CodexActiveModel]).annotate(
	{
		identifier: 'ActiveModel',
		discriminator: 'providerKind',
	},
)
export type ActiveModel = typeof ActiveModel.Type

/** Encoded schema object to JSON for persisted system messages. */
export const SystemMessageEncoded = Schema.toEncoded(Prompt.SystemMessage)
export type SystemMessageEncoded = typeof SystemMessageEncoded.Type

/** Encoded schema object to JSON for persisted user messages. */
export const UserMessageEncoded = Schema.toEncoded(Prompt.UserMessage)
export type UserMessageEncoded = typeof UserMessageEncoded.Type

/** Encoded schema object to JSON for persisted assistant messages. */
export const AssistantMessageEncoded = Schema.toEncoded(Prompt.AssistantMessage)
export type AssistantMessageEncoded = typeof AssistantMessageEncoded.Type

/** Encoded schema object to JSON for persisted tool result messages. */
export const ToolMessageEncoded = Schema.toEncoded(Prompt.ToolMessage)
export type ToolMessageEncoded = typeof ToolMessageEncoded.Type

/** Encoded schema object to JSON for persisted model usage. */
export const UsageEncoded = Schema.toEncoded(Response.Usage)
export type UsageEncoded = typeof UsageEncoded.Type

type AgentRunContext = {
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId | null
}

const AgentRunContextFilter = Schema.makeFilter<AgentRunContext>(
	({ parentAgentId, toolCallId }) => {
		const bothNull = parentAgentId === null && toolCallId === null
		const bothSet = parentAgentId !== null && toolCallId !== null

		return bothNull || bothSet ? undefined : 'parentAgentId and toolCallId must both be null or both be set'
	},
	{ identifier: 'AgentRunContext' },
)

/** Agent launch mode - whether the agent was launched with a fresh context window or forked from a parent. */
export const AgentLaunchMode = Schema.Literals(['fresh', 'fork']).annotate({ identifier: 'AgentLaunchMode' })
export type AgentLaunchMode = typeof AgentLaunchMode.Type

/** Fork metadata for forked agents. */
export const AgentFork = Schema.Struct({
	fromAgentId: AgentId,
	atSeq: LogSeq,
}).annotate({ identifier: 'AgentFork' })
export type AgentFork = typeof AgentFork.Type

type AgentStartedContext = AgentRunContext & {
	readonly mode: AgentLaunchMode
	readonly fork: AgentFork | null
}

const AgentStartedContextFilter = Schema.makeFilter<AgentStartedContext>(
	({ fork, mode, parentAgentId }) => {
		if (mode === 'fresh' && fork !== null) return 'fresh agent_started entries must not include fork metadata'
		if (mode === 'fork' && fork === null) return 'fork agent_started entries must include fork metadata'
		if (mode === 'fork' && parentAgentId === null) return 'fork agent_started entries must have a parentAgentId'
		return undefined
	},
	{ identifier: 'AgentStartedContext' },
)

/** Session started log entry input. The entry is session-scoped, but carries the root agent id. `cwd` is null on hosts without a filesystem (browser, workers). */
export const SessionStartedLogEntryInput = Schema.TaggedStruct('session_started', {
	agentId: Schema.Null,
	parentAgentId: Schema.Null,
	toolCallId: Schema.Null,
	version: LogVersion,
	cwd: Schema.NullOr(Schema.String),
	sessionId: SessionId,
	rootAgentId: AgentId,
	meta: Schema.Record(Schema.String, Schema.Json),
}).annotate({ identifier: 'SessionStartedLogEntryInput' })
export type SessionStartedLogEntryInput = typeof SessionStartedLogEntryInput.Type

/** Stored session started log entry. */
export const SessionStartedLogEntry = Schema.TaggedStruct('session_started', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: Schema.Null,
	parentAgentId: Schema.Null,
	toolCallId: Schema.Null,
	version: LogVersion,
	cwd: Schema.NullOr(Schema.String),
	sessionId: SessionId,
	rootAgentId: AgentId,
	meta: Schema.Record(Schema.String, Schema.Json),
}).annotate({ identifier: 'SessionStartedLogEntry' })
export type SessionStartedLogEntry = typeof SessionStartedLogEntry.Type

/** Agent started log entry input - emitted for parent agents and subagents. */
export const AgentStartedLogEntryInput = Schema.TaggedStruct('agent_started', {
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	mode: AgentLaunchMode,
	model: ActiveModel,
	tools: Schema.Array(Schema.String),
	skill: Schema.NullOr(Schema.String),
	fork: Schema.NullOr(AgentFork),
	/** Registry type name the agent was dispatched as (D21); null for the root agent and forks. */
	agentType: Schema.NullOr(Schema.String),
})
	.check(AgentRunContextFilter)
	.check(AgentStartedContextFilter)
	.annotate({ identifier: 'AgentStartedLogEntryInput' })
export type AgentStartedLogEntryInput = typeof AgentStartedLogEntryInput.Type

/** Stored agent started log entry. */
export const AgentStartedLogEntry = Schema.TaggedStruct('agent_started', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	mode: AgentLaunchMode,
	model: ActiveModel,
	tools: Schema.Array(Schema.String),
	skill: Schema.NullOr(Schema.String),
	fork: Schema.NullOr(AgentFork),
	/** Registry type name the agent was dispatched as (D21); null for the root agent and forks. */
	agentType: Schema.NullOr(Schema.String),
})
	.check(AgentRunContextFilter)
	.check(AgentStartedContextFilter)
	.annotate({ identifier: 'AgentStartedLogEntry' })
export type AgentStartedLogEntry = typeof AgentStartedLogEntry.Type

/** Some providers support inline system messages; others only support leading ones. */
export const SystemMessagePlacement = Schema.Literals(['leading', 'inline']).annotate({
	identifier: 'SystemMessagePlacement',
})
export type SystemMessagePlacement = typeof SystemMessagePlacement.Type

/** Input for a system message log entry. One entry carries the full ordered block set - one encoded system message per block - so leading supersession stays atomic. */
export const SystemMessageLogEntryInput = Schema.TaggedStruct('system-message', {
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	messageId: MessageId,
	messages: Schema.NonEmptyArray(SystemMessageEncoded),
	placement: SystemMessagePlacement,
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'SystemMessageLogEntryInput' })
export type SystemMessageLogEntryInput = typeof SystemMessageLogEntryInput.Type

/** Log entry for a system message block set. */
export const SystemMessageLogEntry = Schema.TaggedStruct('system-message', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	messageId: MessageId,
	messages: Schema.NonEmptyArray(SystemMessageEncoded),
	placement: SystemMessagePlacement,
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'SystemMessageLogEntry' })
export type SystemMessageLogEntry = typeof SystemMessageLogEntry.Type

/** Input for a user message log entry. */
export const UserMessageLogEntryInput = Schema.TaggedStruct('user-message', {
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	messageId: MessageId,
	message: UserMessageEncoded,
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'UserMessageLogEntryInput' })
export type UserMessageLogEntryInput = typeof UserMessageLogEntryInput.Type

/** Log entry for user messages. */
export const UserMessageLogEntry = Schema.TaggedStruct('user-message', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	messageId: MessageId,
	message: UserMessageEncoded,
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'UserMessageLogEntry' })
export type UserMessageLogEntry = typeof UserMessageLogEntry.Type

/** Input for an assistant message log entry. */
export const AssistantMessageLogEntryInput = Schema.TaggedStruct('assistant-message', {
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	messageId: MessageId,
	message: AssistantMessageEncoded,
	finish: Schema.NullOr(
		Schema.Struct({
			reason: Response.FinishReason,
			usage: UsageEncoded,
		}),
	),
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'AssistantMessageLogEntryInput' })
export type AssistantMessageLogEntryInput = typeof AssistantMessageLogEntryInput.Type

/** Log entry for assistant messages. */
export const AssistantMessageLogEntry = Schema.TaggedStruct('assistant-message', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	messageId: MessageId,
	message: AssistantMessageEncoded,
	finish: Schema.NullOr(
		Schema.Struct({
			reason: Response.FinishReason,
			usage: UsageEncoded,
		}),
	),
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'AssistantMessageLogEntry' })
export type AssistantMessageLogEntry = typeof AssistantMessageLogEntry.Type

/** Input for a tool result log entry. */
export const ToolResultLogEntryInput = Schema.TaggedStruct('tool-result', {
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: ToolCallId,
	messageId: MessageId,
	message: ToolMessageEncoded,
	executedInput: Schema.optional(Schema.Unknown), // if the hook modifies
}).annotate({ identifier: 'ToolResultLogEntryInput' })
export type ToolResultLogEntryInput = typeof ToolResultLogEntryInput.Type

/** Log entry for tool results. */
export const ToolResultLogEntry = Schema.TaggedStruct('tool-result', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: ToolCallId,
	messageId: MessageId,
	message: ToolMessageEncoded,
	executedInput: Schema.optional(Schema.Unknown), // e.g. if the hook modifies
}).annotate({ identifier: 'ToolResultLogEntry' })
export type ToolResultLogEntry = typeof ToolResultLogEntry.Type

/** Input for a tool state update log entry. toolCallId is null when a hook writes outside a tool call. */
export const ToolStateLogEntryInput = Schema.TaggedStruct('tool_state', {
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	namespace: Schema.String,
	stateId: StateId,
	key: Schema.String,
	value: Schema.Unknown,
}).annotate({ identifier: 'ToolStateLogEntryInput' })
export type ToolStateLogEntryInput = typeof ToolStateLogEntryInput.Type

/** Schema for a tool state update log entry. toolCallId is null when a hook writes outside a tool call. */
export const ToolStateLogEntry = Schema.TaggedStruct('tool_state', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	namespace: Schema.String,
	stateId: StateId,
	key: Schema.String,
	value: Schema.Unknown,
}).annotate({ identifier: 'ToolStateLogEntry' })
export type ToolStateLogEntry = typeof ToolStateLogEntry.Type

/** Input for a compaction log entry. */
export const CompactionLogEntryInput = Schema.TaggedStruct('compaction', {
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	compactionId: CompactionId,
	summary: Schema.String,
	replacesThroughSeq: LogSeq,
	tokensBefore: Schema.Number,
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'CompactionLogEntryInput' })
export type CompactionLogEntryInput = typeof CompactionLogEntryInput.Type

/** Schema for a compaction log entry. */
export const CompactionLogEntry = Schema.TaggedStruct('compaction', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	compactionId: CompactionId,
	summary: Schema.String,
	replacesThroughSeq: LogSeq,
	tokensBefore: Schema.Number,
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'CompactionLogEntry' })
export type CompactionLogEntry = typeof CompactionLogEntry.Type

/** Input for a model change log entry. */
export const ModelChangeLogEntryInput = Schema.TaggedStruct('model-change', {
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	model: ActiveModel,
	reason: Schema.NullOr(Schema.String),
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'ModelChangeLogEntryInput' })
export type ModelChangeLogEntryInput = typeof ModelChangeLogEntryInput.Type

/** Schema for model change log entry. */
export const ModelChangeLogEntry = Schema.TaggedStruct('model-change', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	model: ActiveModel,
	reason: Schema.NullOr(Schema.String),
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'ModelChangeLogEntry' })
export type ModelChangeLogEntry = typeof ModelChangeLogEntry.Type

/** Input for a thinking / reasoning setting change. */
export const ThinkingChangeLogEntryInput = Schema.TaggedStruct('thinking-change', {
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	reasoningLevel: ReasoningLevel,
	reason: Schema.NullOr(Schema.String),
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'ThinkingChangeLogEntryInput' })
export type ThinkingChangeLogEntryInput = typeof ThinkingChangeLogEntryInput.Type

/** Schema for thinking / reasoning setting changes. */
export const ThinkingChangeLogEntry = Schema.TaggedStruct('thinking-change', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	reasoningLevel: ReasoningLevel,
	reason: Schema.NullOr(Schema.String),
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'ThinkingChangeLogEntry' })
export type ThinkingChangeLogEntry = typeof ThinkingChangeLogEntry.Type

/** Input for an active toolset change. */
export const ToolsChangeLogEntryInput = Schema.TaggedStruct('tools-change', {
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	tools: Schema.Array(Schema.String),
	reason: Schema.NullOr(Schema.String),
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'ToolsChangeLogEntryInput' })
export type ToolsChangeLogEntryInput = typeof ToolsChangeLogEntryInput.Type

/** Schema for active toolset changes. */
export const ToolsChangeLogEntry = Schema.TaggedStruct('tools-change', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	tools: Schema.Array(Schema.String),
	reason: Schema.NullOr(Schema.String),
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'ToolsChangeLogEntry' })
export type ToolsChangeLogEntry = typeof ToolsChangeLogEntry.Type

/** Schema for the outcome of an agent event. */
export const AgentFinishedOutcome = Schema.Literals(['completed', 'stopped', 'interrupted', 'error']).annotate({
	identifier: 'AgentFinishedOutcome',
})
export type AgentFinishedOutcome = typeof AgentFinishedOutcome.Type

/** Input for an agent's terminal state. */
export const AgentFinishedLogEntryInput = Schema.TaggedStruct('agent-finished', {
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	outcome: AgentFinishedOutcome,
	resultText: Schema.NullOr(Schema.String),
	reason: Schema.NullOr(Schema.String),
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'AgentFinishedLogEntryInput' })
export type AgentFinishedLogEntryInput = typeof AgentFinishedLogEntryInput.Type

/** Schema for an agent's terminal state. */
export const AgentFinishedLogEntry = Schema.TaggedStruct('agent-finished', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	outcome: AgentFinishedOutcome,
	resultText: Schema.NullOr(Schema.String),
	reason: Schema.NullOr(Schema.String),
})
	.check(AgentRunContextFilter)
	.annotate({ identifier: 'AgentFinishedLogEntry' })
export type AgentFinishedLogEntry = typeof AgentFinishedLogEntry.Type

/** Input for a durable error note in the log. */
export const ErrorLogEntryInput = Schema.TaggedStruct('error', {
	agentId: Schema.NullOr(AgentId),
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	errorType: Schema.String,
	message: Schema.String,
	details: Schema.Record(Schema.String, Schema.Json),
}).annotate({ identifier: 'ErrorLogEntryInput' })
export type ErrorLogEntryInput = typeof ErrorLogEntryInput.Type

/** Schema for a durable error note in the log. */
export const ErrorLogEntry = Schema.TaggedStruct('error', {
	seq: LogSeq,
	ts: EpochMillis,
	agentId: Schema.NullOr(AgentId),
	parentAgentId: Schema.NullOr(AgentId),
	toolCallId: Schema.NullOr(ToolCallId),
	errorType: Schema.String,
	message: Schema.String,
	details: Schema.Record(Schema.String, Schema.Json),
}).annotate({ identifier: 'ErrorLogEntry' })
export type ErrorLogEntry = typeof ErrorLogEntry.Type

/** Append-time log entry schema. `EventLog.append` assigns `seq` and `ts`. */
export const LogEntryInput = Schema.Union([
	SessionStartedLogEntryInput,
	AgentStartedLogEntryInput,
	SystemMessageLogEntryInput,
	UserMessageLogEntryInput,
	AssistantMessageLogEntryInput,
	ToolResultLogEntryInput,
	ToolStateLogEntryInput,
	CompactionLogEntryInput,
	ModelChangeLogEntryInput,
	ThinkingChangeLogEntryInput,
	ToolsChangeLogEntryInput,
	AgentFinishedLogEntryInput,
	ErrorLogEntryInput,
]).annotate({ identifier: 'LogEntryInput', discriminator: '_tag' })
export type LogEntryInput = typeof LogEntryInput.Type

/** Stored log entry schema. */
export const LogEntry = Schema.Union([
	SessionStartedLogEntry,
	AgentStartedLogEntry,
	SystemMessageLogEntry,
	UserMessageLogEntry,
	AssistantMessageLogEntry,
	ToolResultLogEntry,
	ToolStateLogEntry,
	CompactionLogEntry,
	ModelChangeLogEntry,
	ThinkingChangeLogEntry,
	ToolsChangeLogEntry,
	AgentFinishedLogEntry,
	ErrorLogEntry,
]).annotate({ identifier: 'LogEntry', discriminator: '_tag' })
export type LogEntry = typeof LogEntry.Type
export type LogEntryEncoded = typeof LogEntry.Encoded
