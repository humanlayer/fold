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
import { Effect, Encoding, Match, Option, Schema } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import type { ProjectedMessage } from '../Projection/Projection'
import { ToolResultOutput } from '../Tools/ToolResultContent'

const anthropicEphemeralCacheControl = { type: 'ephemeral' } as const

/** Vendor key in a part's provider-options bag where fold stashes its own metadata. */
export const foldPartOptionsKey = 'fold'

/** Field inside the fold options bag holding the provider-assigned tool call id. */
export const providerToolCallIdKey = 'providerToolCallId'

/** A projected message could not be decoded into a live Prompt message. */
export class PromptDecodeError extends Schema.TaggedError<PromptDecodeError>()('PromptDecodeError', {
	sourceSeq: Schema.Number,
	entryTag: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

const decodeSystemMessage = Schema.decodeUnknownEffect(Prompt.SystemMessage)
const decodeUserMessage = Schema.decodeUnknownEffect(Prompt.UserMessage)
const decodeAssistantMessage = Schema.decodeUnknownEffect(Prompt.AssistantMessage)
const decodeToolMessage = Schema.decodeUnknownEffect(Prompt.ToolMessage)
const decodeFoldPartOptions = Schema.decodeUnknownOption(Schema.Struct({ [providerToolCallIdKey]: Schema.String }))
const decodeToolResultOutput = Schema.decodeUnknownOption(ToolResultOutput)

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

/** Convert a durable canonical result to provider-neutral live Prompt content. */
const prepareToolResult = (result: unknown): Effect.Effect<unknown, Encoding.EncodingError> => {
	const decoded = decodeToolResultOutput(result)
	if (Option.isNone(decoded)) return Effect.succeed(result)

	return Match.value(decoded.value).pipe(
		Match.tagsExhaustive({
			text: ({ text }) => Effect.succeed(text),
			failure: ({ text }) => Effect.succeed(text),
			multipart: ({ content }) =>
				Effect.forEach(content, (part) =>
					Match.value(part).pipe(
						Match.tagsExhaustive({
							'text-part': ({ text }) => Effect.succeed(Prompt.textPart({ text })),
							'image-part': ({ data, mediaType, fileName }) =>
								Effect.fromResult(Encoding.decodeBase64(data)).pipe(
									Effect.map((bytes) => Prompt.filePart({ data: bytes, mediaType, fileName })),
								),
						}),
					),
				),
		}),
	)
}

/** Prepare each canonical result while retaining the surrounding tool message. */
const prepareToolMessage = (message: Prompt.ToolMessage): Effect.Effect<Prompt.ToolMessage, Encoding.EncodingError> =>
	Effect.forEach(message.content, (part): Effect.Effect<Prompt.ToolMessagePart, Encoding.EncodingError> =>
		part.type === 'tool-result'
			? prepareToolResult(part.result).pipe(Effect.map((result) => Prompt.toolResultPart({ ...part, result })))
			: Effect.succeed(part),
	).pipe(Effect.map((content) => Prompt.toolMessage({ content, options: message.options })))

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
			yield* Match.valueTags(projected, {
				'system-message': (message) =>
					Effect.gen(function* () {
						for (const encoded of message.messages) {
							promptMessages.push(
								yield* decodeSystemMessage(encoded).pipe(Effect.mapError(decodeErrorFor(message))),
							)
						}
					}),
				'user-message': (message) =>
					decodeUserMessage(message.message).pipe(
						Effect.mapError(decodeErrorFor(message)),
						Effect.tap((decoded) => Effect.sync(() => promptMessages.push(decoded))),
					),
				'assistant-message': (message) =>
					decodeAssistantMessage(message.message).pipe(
						Effect.mapError(decodeErrorFor(message)),
						Effect.tap((decoded) =>
							Effect.sync(() =>
								promptMessages.push(restoreAssistantToolCallIds(decoded, providerIdsByFoldId)),
							),
						),
					),
				'tool-result': (result) =>
					decodeToolMessage(result.message).pipe(
						Effect.mapError(decodeErrorFor(result)),
						Effect.flatMap((decoded) =>
							prepareToolMessage(restoreToolResultIds(decoded, providerIdsByFoldId)),
						),
						Effect.mapError(decodeErrorFor(result)),
						Effect.tap((message) => Effect.sync(() => promptMessages.push(message))),
					),
				'compaction-summary': (summary) =>
					Effect.sync(() => {
						promptMessages.push(
							compactionSummaryMessage(summary.summary, summary.postCompactionInstructions),
						)
					}),
			})
		}

		return Prompt.fromMessages(markLatestUserSideCacheBreakpoint(promptMessages))
	})
