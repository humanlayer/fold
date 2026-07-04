import { Schema } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import { AgentId, ToolCallId } from '../Ids'

/**
 * Input for hooks that can transform the outgoing model request.
 *
 * AgentRuntime calls this after building a prompt from the log projection and
 * before calling LanguageModel.streamText.
 */
export const PreRequestHookInput = Schema.Struct({
	agentId: AgentId,
	prompt: Prompt.Prompt,
}).annotate({ identifier: 'PreRequestHookInput' })
export type PreRequestHookInput = typeof PreRequestHookInput.Type

/**
 * a pre-request hook either leaves the prompt alone OR replaces it
 * it NEVER mutates the {@link EventLog} - it only changes what the body of the outbound request
 * to the model sees
 */
export const PreRequestHookDecision = Schema.Union([
	Schema.TaggedStruct('unchanged', {}),
	Schema.TaggedStruct('changed', {
		prompt: Prompt.Prompt,
	}),
]).annotate({ identifier: 'PreRequestHookDecision', discriminator: '_tag' })
export type PreRequestHookDecision = typeof PreRequestHookDecision.Type

/**
 * Input for hooks that run AFTER the model generates a tool call but BEFORE the function is executed
 *
 * ToolRuntime calls this after the assistant tool call message has been persisted and
 * before the tool handler function is invoked
 */
export const PreToolUseHookInput = Schema.Struct({
	agentId: AgentId,
	toolCallId: ToolCallId,
	toolName: Schema.String,
	params: Schema.Unknown,
})
export type PreToolUseHookInput = typeof PreToolUseHookInput.Type

/**
 * Decision made by a preToolUse hook. A preToolUse hook can:
 * - continue with original or updated params
 * - replace the tool result without executing the handler
 */
export const PreToolUseHookDecision = Schema.Union([
	Schema.TaggedStruct('continue', {
		params: Schema.Unknown,
	}),
	Schema.TaggedStruct('replaceResult', {
		result: Schema.Unknown,
		isFailure: Schema.Boolean,
	}),
]).annotate({ identifier: 'PreToolUseHookDecision', discriminator: '_tag' })
export type PreToolUseHookDecision = typeof PreToolUseHookDecision.Type

/**
 * Input for hooks that run after a successful tool handler result.
 *
 * postToolUse is skipped for failure results.
 */
export const PostToolUseHookInput = Schema.Struct({
	agentId: AgentId,
	toolCallId: ToolCallId,
	toolName: Schema.String,
	result: Schema.Unknown,
	isFailure: Schema.Boolean,
}).annotate({ identifier: 'PostToolUseHookInput' })
export type PostToolUseHookInput = typeof PostToolUseHookInput.Type

/**
 * A postToolUse hook can keep the handler result or replace it.
 */
export const PostToolUseHookDecision = Schema.Union([
	Schema.TaggedStruct('keep', {}),
	Schema.TaggedStruct('replace', {
		result: Schema.Unknown,
		isFailure: Schema.Boolean,
	}),
]).annotate({ identifier: 'PostToolUseHookDecision', discriminator: '_tag' })
export type PostToolUseHookDecision = typeof PostToolUseHookDecision.Type

/**
 * Input for hooks that run when an agent would naturally finish.
 *
 * AgentRuntime calls this only when the model returns no tool calls.
 */
export const OnCompleteHookInput = Schema.Struct({
	agentId: AgentId,
	resultText: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'OnCompleteHookInput' })
export type OnCompleteHookInput = typeof OnCompleteHookInput.Type

/**
 * An onComplete hook can complete the run or continue with another user message.
 */
export const OnCompleteHookDecision = Schema.Union([
	Schema.TaggedStruct('complete', {}),
	Schema.TaggedStruct('continueWith', {
		text: Schema.String,
	}),
]).annotate({ identifier: 'OnCompleteHookDecision', discriminator: '_tag' })
export type OnCompleteHookDecision = typeof OnCompleteHookDecision.Type
