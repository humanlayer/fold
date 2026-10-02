/**
 * Read helpers over the content of persisted (encoded) prompt messages. User, assistant, and tool
 * messages store their content in Effect AI's encoded Prompt shape: a bare string or a list of encoded
 * parts. Compaction, projection, and the CLI renderer all read that content through these helpers so
 * the string/parts normalization lives in one place.
 */
import { Match, Option, Schema } from 'effect'
import type { Prompt } from 'effect/unstable/ai'

/** Content of a persisted user, assistant, or tool message. */
export type EncodedMessageContent =
	| Prompt.UserMessageEncoded['content']
	| Prompt.AssistantMessageEncoded['content']
	| Prompt.ToolMessageEncoded['content']

/** One encoded part of a persisted message. */
export type EncodedContentPart = Prompt.PartEncoded

/** Normalize persisted message content to its parts; a bare string is one text part. */
export const encodedContentParts = (content: EncodedMessageContent): ReadonlyArray<EncodedContentPart> =>
	Match.value(content).pipe(
		Match.when(Match.string, (text): ReadonlyArray<EncodedContentPart> => [{ type: 'text', text }]),
		Match.orElse((parts): ReadonlyArray<EncodedContentPart> => parts),
	)

/** Narrow encoded parts to one part type, for `filter`/`find`/`some`. */
export const isPartOfType =
	<Type extends EncodedContentPart['type']>(type: Type) =>
	(part: EncodedContentPart): part is Extract<EncodedContentPart, { readonly type: Type }> =>
		part.type === type

/** Concatenate the text parts of persisted message content. */
export const encodedContentText = (content: EncodedMessageContent): string =>
	encodedContentParts(content)
		.filter(isPartOfType('text'))
		.map((part) => part.text)
		.join('')

// Effect AI leaves tool-call params and tool results schema-free, so their JSON rendering can fail
// (cycles, bigints); each renderer below falls back to a plain-text form for that case.
const encodeJsonText = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** Render a tool call's params as JSON text. */
export const toolCallParamsText = (part: Prompt.ToolCallPartEncoded): string =>
	Option.getOrElse(encodeJsonText(part.params), () => String(part.params))

/** Render a tool result's payload as JSON text. */
export const toolResultText = (part: Prompt.ToolResultPartEncoded): string =>
	Option.getOrElse(encodeJsonText(part.result), () => String(part.result))

/** Render a whole encoded part as JSON text. */
export const contentPartText = (part: EncodedContentPart): string =>
	Option.getOrElse(encodeJsonText(part), () => `[${part.type} part]`)

const encodeJson = Schema.encodeOption(Schema.fromJsonString(Schema.Json))

/** Render a JSON value (for example a tool progress payload) as JSON text. */
export const jsonText = (value: Schema.Json): string => Option.getOrElse(encodeJson(value), () => '[unrenderable JSON]')
