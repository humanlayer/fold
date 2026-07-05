/**
 * This file converts the projected conversation read model into a live Effect AI Prompt for one model
 * request. It is the provider-boundary decode step: the log stores Encoded message forms, the model
 * client wants live Prompt messages. It also restores the provider-assigned tool-call ids that
 * AgentRuntime stashed in part options at persist time, so providers see exactly the ids they minted.
 *
 * Cache law: this module must never substitute hook-mutated execution params or any other audit
 * metadata into history. The assistant tool-call params stay exactly as decoded from the persisted
 * assistant message, keeping already-sent prompt bytes stable across turns.
 */
import { Effect, Schema } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import type { ProjectedMessage } from '../Projection/Projection'

/** Vendor key in a part's provider-options bag where tart stashes its own metadata. */
export const tartPartOptionsKey = 'tart'

/** Field inside the tart options bag holding the provider-assigned tool call id. */
export const providerToolCallIdKey = 'providerToolCallId'

/** A projected message could not be decoded into a live Prompt message. */
export class PromptDecodeError extends Schema.TaggedErrorClass<PromptDecodeError>()('PromptDecodeError', {
	sourceSeq: Schema.Number,
	entryTag: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

const decodeSystemMessage = Schema.decodeUnknownEffect(Prompt.SystemMessage)
const decodeUserMessage = Schema.decodeUnknownEffect(Prompt.UserMessage)
const decodeAssistantMessage = Schema.decodeUnknownEffect(Prompt.AssistantMessage)
const decodeToolMessage = Schema.decodeUnknownEffect(Prompt.ToolMessage)

const decodeErrorFor = (projected: ProjectedMessage) => (cause: unknown) =>
	new PromptDecodeError({
		sourceSeq: projected.sourceSeq,
		entryTag: projected._tag,
		message: `Unable to decode ${projected._tag} at seq ${projected.sourceSeq}`,
		cause,
	})

/** Narrow an unknown JSON value to a plain object record. */
const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** Read the provider-assigned tool call id tart stashed on a persisted part, when present. */
const stashedProviderToolCallId = (options: Prompt.ToolCallPart['options']): string | null => {
	const bag: unknown = options[tartPartOptionsKey]
	if (!isJsonRecord(bag)) return null

	const providerId = bag[providerToolCallIdKey]
	return typeof providerId === 'string' ? providerId : null
}

/** Restore provider tool-call ids on an assistant message, recording the mapping for tool results. */
const restoreAssistantToolCallIds = (
	message: Prompt.AssistantMessage,
	providerIdsByTartId: Map<string, string>,
): Prompt.AssistantMessage =>
	Prompt.assistantMessage({
		content: message.content.map((part) => {
			if (part.type !== 'tool-call') return part

			const providerId = stashedProviderToolCallId(part.options)
			if (providerId === null) return part

			providerIdsByTartId.set(part.id, providerId)
			return Prompt.toolCallPart({ ...part, id: providerId })
		}),
		options: message.options,
	})

/** Restore provider tool-call ids on a tool message using the assistant-side mapping. */
const restoreToolResultIds = (
	message: Prompt.ToolMessage,
	providerIdsByTartId: Map<string, string>,
): Prompt.ToolMessage =>
	Prompt.toolMessage({
		content: message.content.map((part) => {
			if (part.type !== 'tool-result') return part

			const providerId = providerIdsByTartId.get(part.id)
			if (providerId === undefined) return part

			return Prompt.toolResultPart({ ...part, id: providerId })
		}),
		options: message.options,
	})

/** Render a compaction summary as the user-visible stand-in for the history it replaced. */
const compactionSummaryMessage = (summary: string): Prompt.UserMessage =>
	Prompt.userMessage({
		content: [Prompt.textPart({ text: `<conversation-summary>\n${summary}\n</conversation-summary>` })],
	})

/**
 * Build the live Prompt for one model request from an agent's projected messages.
 *
 * System messages decode in place; provider-family-specific rendering of inline system messages and
 * image tool results is a later enhancement behind this same seam.
 */
export const buildPrompt = (
	messages: ReadonlyArray<ProjectedMessage>,
): Effect.Effect<Prompt.Prompt, PromptDecodeError> =>
	Effect.gen(function* () {
		const providerIdsByTartId = new Map<string, string>()
		const promptMessages: Array<Prompt.Message> = []

		for (const projected of messages) {
			switch (projected._tag) {
				case 'system-message':
					promptMessages.push(
						yield* decodeSystemMessage(projected.message).pipe(Effect.mapError(decodeErrorFor(projected))),
					)
					break

				case 'user-message':
					promptMessages.push(
						yield* decodeUserMessage(projected.message).pipe(Effect.mapError(decodeErrorFor(projected))),
					)
					break

				case 'assistant-message': {
					const decoded = yield* decodeAssistantMessage(projected.message).pipe(
						Effect.mapError(decodeErrorFor(projected)),
					)
					promptMessages.push(restoreAssistantToolCallIds(decoded, providerIdsByTartId))
					break
				}

				case 'tool-result': {
					const decoded = yield* decodeToolMessage(projected.message).pipe(
						Effect.mapError(decodeErrorFor(projected)),
					)
					promptMessages.push(restoreToolResultIds(decoded, providerIdsByTartId))
					break
				}

				case 'compaction-summary':
					promptMessages.push(compactionSummaryMessage(projected.summary))
					break
			}
		}

		return Prompt.fromMessages(promptMessages)
	})
