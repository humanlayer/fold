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
import { Effect, Option, Schema } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import type { ProjectedMessage } from '../Projection/Projection'
import { ToolResultImageBlock } from '../Tools/ToolResultContent'

const anthropicEphemeralCacheControl = { type: 'ephemeral' } as const

/** Vendor key in a part's provider-options bag where fold stashes its own metadata. */
export const foldPartOptionsKey = 'fold'

/** Field inside the fold options bag holding the provider-assigned tool call id. */
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
const decodeJsonObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeFoldPartOptions = Schema.decodeUnknownOption(Schema.Struct({ [providerToolCallIdKey]: Schema.String }))
const decodeToolResultContent = Schema.decodeUnknownOption(Schema.Struct({ content: Schema.Array(Schema.Unknown) }))

const decodeErrorFor = (projected: ProjectedMessage) => (cause: unknown) =>
	new PromptDecodeError({
		sourceSeq: projected.sourceSeq,
		entryTag: projected._tag,
		message: `Unable to decode ${projected._tag} at seq ${projected.sourceSeq}`,
		cause,
	})

/** Read the provider-assigned tool call id fold stashed on a persisted part, when present. */
const stashedProviderToolCallId = (options: Prompt.ToolCallPart['options']): string | null => {
	const decoded = decodeFoldPartOptions(options[foldPartOptionsKey])
	return Option.isSome(decoded) ? decoded.value[providerToolCallIdKey] : null
}

/** Restore provider tool-call ids on an assistant message, recording the mapping for tool results. */
const restoreAssistantToolCallIds = (
	message: Prompt.AssistantMessage,
	providerIdsByFoldId: Map<string, string>,
): Prompt.AssistantMessage =>
	Prompt.assistantMessage({
		content: message.content.map((part) => {
			if (part.type !== 'tool-call') return part

			const providerId = stashedProviderToolCallId(part.options)
			if (providerId === null) return part

			providerIdsByFoldId.set(part.id, providerId)
			return Prompt.toolCallPart({ ...part, id: providerId })
		}),
		options: message.options,
	})

/** Restore provider tool-call ids on a tool message using the assistant-side mapping. */
const restoreToolResultIds = (
	message: Prompt.ToolMessage,
	providerIdsByFoldId: Map<string, string>,
): Prompt.ToolMessage =>
	Prompt.toolMessage({
		content: message.content.map((part) => {
			if (part.type !== 'tool-result') return part

			const providerId = providerIdsByFoldId.get(part.id)
			if (providerId === undefined) return part

			return Prompt.toolResultPart({ ...part, id: providerId })
		}),
		options: message.options,
	})

/** Render a compaction summary as the user-visible stand-in for the history it replaced. */
const compactionSummaryMessage = (summary: string, postCompactionInstructions?: string): Prompt.UserMessage =>
	Prompt.userMessage({
		content: [
			Prompt.textPart({
				text:
					`<conversation-summary>\n${summary}\n</conversation-summary>` +
					(postCompactionInstructions === undefined ? '' : `\n\n${postCompactionInstructions}`),
			}),
		],
	})

const cacheMarkedUserMessage = (message: Prompt.UserMessage): Prompt.UserMessage =>
	Prompt.userMessage({
		content: message.content,
		options: {
			...message.options,
			anthropic: { ...message.options.anthropic, cacheControl: anthropicEphemeralCacheControl },
		},
	})

const cacheMarkedToolMessage = (message: Prompt.ToolMessage): Prompt.ToolMessage =>
	Prompt.toolMessage({
		content: message.content,
		options: {
			...message.options,
			anthropic: { ...message.options.anthropic, cacheControl: anthropicEphemeralCacheControl },
		},
	})

/**
 * Mark the latest user-side boundary as a cache breakpoint. Anthropic sees tool-result messages as user
 * content, so this follows pi/opencode's growing-conversation strategy: system breakpoint covers the
 * stable prefix, and the latest user/tool boundary lets subsequent turns read the previous prefix and
 * write the extended one.
 */
const markLatestUserSideCacheBreakpoint = (messages: ReadonlyArray<Prompt.Message>): ReadonlyArray<Prompt.Message> => {
	const out = [...messages]
	for (let index = out.length - 1; index >= 0; index -= 1) {
		const message = out[index]
		if (message === undefined) continue

		if (message.role === 'user') {
			out[index] = cacheMarkedUserMessage(message)
			break
		}

		if (message.role === 'tool') {
			out[index] = cacheMarkedToolMessage(message)
			break
		}
	}

	return out
}

/** Placeholder left inside a tool result where an image block was lifted out (D3 delivery path). */
export const imageOmittedPlaceholder =
	'[Image omitted here. It is attached as a file part in the user message immediately following this tool result.]'

const isImageBlock = Schema.is(ToolResultImageBlock)

/**
 * Split image blocks out of one tool-result value following the built-in content-block convention
 * (`{ content: [text | image, ...] }`). Returns null when the value carries no images.
 */
const splitImageBlocks = (
	result: unknown,
): { readonly sanitized: unknown; readonly images: ReadonlyArray<ToolResultImageBlock> } | null => {
	const envelope = decodeToolResultContent(result)
	const object = decodeJsonObject(result)
	if (Option.isNone(envelope) || Option.isNone(object)) return null

	const images = envelope.value.content.filter(isImageBlock)
	if (images.length === 0) return null

	return {
		sanitized: {
			...object.value,
			content: envelope.value.content.map((block: unknown) =>
				isImageBlock(block) ? { type: 'text', text: imageOmittedPlaceholder } : block,
			),
		},
		images,
	}
}

/**
 * Deliver image blocks from tool results as native user file parts (D3): the provider serializes
 * custom tool results as JSON text (verified fact 1), so images inside tool_result would reach the
 * model as base64 noise. The image block is replaced with placeholder text and re-sent as a user
 * message file part immediately after the tool message - uniform across providers (fact 2).
 */
const liftImagesFromToolMessage = (
	message: Prompt.ToolMessage,
): { readonly message: Prompt.ToolMessage; readonly followUp: Prompt.UserMessage | null } => {
	const imageParts: Array<Prompt.UserMessagePart> = []
	const content = message.content.map((part) => {
		if (part.type !== 'tool-result') return part

		const split = splitImageBlocks(part.result)
		if (split === null) return part

		for (const image of split.images) {
			imageParts.push(Prompt.filePart({ mediaType: image.mimeType, data: image.data }))
		}
		return Prompt.toolResultPart({ ...part, result: split.sanitized })
	})

	if (imageParts.length === 0) return { message, followUp: null }

	return {
		message: Prompt.toolMessage({ content, options: message.options }),
		followUp: Prompt.userMessage({
			content: [
				Prompt.textPart({ text: 'The following image content belongs to the preceding tool result:' }),
				...imageParts,
			],
		}),
	}
}

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
		const providerIdsByFoldId = new Map<string, string>()
		const promptMessages: Array<Prompt.Message> = []

		for (const projected of messages) {
			switch (projected._tag) {
				case 'system-message':
					for (const encoded of projected.messages) {
						promptMessages.push(
							yield* decodeSystemMessage(encoded).pipe(Effect.mapError(decodeErrorFor(projected))),
						)
					}
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
					promptMessages.push(restoreAssistantToolCallIds(decoded, providerIdsByFoldId))
					break
				}

				case 'tool-result': {
					const decoded = yield* decodeToolMessage(projected.message).pipe(
						Effect.mapError(decodeErrorFor(projected)),
					)
					const { message, followUp } = liftImagesFromToolMessage(
						restoreToolResultIds(decoded, providerIdsByFoldId),
					)
					promptMessages.push(message)
					if (followUp !== null) promptMessages.push(followUp)
					break
				}

				case 'compaction-summary':
					promptMessages.push(
						compactionSummaryMessage(projected.summary, projected.postCompactionInstructions),
					)
					break
			}
		}

		return Prompt.fromMessages(markLatestUserSideCacheBreakpoint(promptMessages))
	})
