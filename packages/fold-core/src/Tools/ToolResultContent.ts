/**
 * Provider-neutral tool results persisted by Fold. Handlers return these tagged values directly;
 * RequestBuilder converts them to live Prompt text/file parts, and providers encode those parts in
 * the native tool-result field. The durable image representation is validated base64.
 */
import { Match, Schema } from 'effect'

/** One plain-text block inside multipart tool output. */
export const ToolResultTextPart = Schema.TaggedStruct('text-part', {
	text: Schema.String,
})
export type ToolResultTextPart = typeof ToolResultTextPart.Type

/** One inline image inside multipart tool output. */
export const ToolResultImagePart = Schema.TaggedStruct('image-part', {
	/** Base64-encoded image bytes without a data URL prefix. */
	data: Schema.String.check(Schema.isBase64()),
	mediaType: Schema.String,
	fileName: Schema.optionalKey(Schema.String),
})
export type ToolResultImagePart = typeof ToolResultImagePart.Type

/** Ordered multipart tool output. */
export const ToolResultPart = Schema.Union([ToolResultTextPart, ToolResultImagePart])
export type ToolResultPart = typeof ToolResultPart.Type

/** Successful plain-text tool output. */
export const ToolResultText = Schema.TaggedStruct('text', {
	text: Schema.String,
})
export type ToolResultText = typeof ToolResultText.Type

/** Successful multipart tool output. */
export const ToolResultMultipart = Schema.TaggedStruct('multipart', {
	content: Schema.Array(ToolResultPart),
})
export type ToolResultMultipart = typeof ToolResultMultipart.Type

/** Expected tool failure with model-visible text and optional durable diagnostics. */
export const ToolResultFailure = Schema.TaggedStruct('failure', {
	text: Schema.String,
	details: Schema.optionalKey(Schema.Json),
})
export type ToolResultFailure = typeof ToolResultFailure.Type

/** Every canonical result a Fold built-in persists. */
export const ToolResultOutput = Schema.Union([ToolResultText, ToolResultMultipart, ToolResultFailure])
export type ToolResultOutput = typeof ToolResultOutput.Type

/** Successful canonical result. */
export const ToolResultSuccess = Schema.Union([ToolResultText, ToolResultMultipart])
export type ToolResultSuccess = typeof ToolResultSuccess.Type

/** Render canonical output for text-only consumers such as Riptide. */
export const renderToolResultOutputText = (output: ToolResultOutput): string =>
	Match.value(output).pipe(
		Match.tagsExhaustive({
			text: ({ text }) => text,
			failure: ({ text }) => text,
			multipart: ({ content }) =>
				content
					.map((part) =>
						Match.value(part).pipe(
							Match.tagsExhaustive({
								'text-part': ({ text }) => text,
								'image-part': () => '[image]',
							}),
						),
					)
					.join('\n'),
		}),
	)
