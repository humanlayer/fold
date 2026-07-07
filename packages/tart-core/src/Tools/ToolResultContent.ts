/**
 * This file defines the shared content-block convention for built-in tool results (D3/D18): a tool's
 * success value is `{ content: [text | image, ...] }`, pi-style. Image blocks are the hard requirement
 * of the read tool; RequestBuilder detects them at request-build time and delivers them as native user
 * file parts (the provider cannot render images inside tool_result JSON - verified fact 1/2), replacing
 * the in-result block with placeholder text.
 */
import { Schema } from 'effect'

/** One plain-text block inside a tool result. */
export const ToolResultTextBlock = Schema.Struct({
	type: Schema.Literal('text'),
	text: Schema.String,
})
export type ToolResultTextBlock = typeof ToolResultTextBlock.Type

/** One inline image inside a tool result: base64 data plus its MIME type. */
export const ToolResultImageBlock = Schema.Struct({
	type: Schema.Literal('image'),
	/** Base64-encoded image bytes. */
	data: Schema.String,
	mimeType: Schema.String,
})
export type ToolResultImageBlock = typeof ToolResultImageBlock.Type

/** The block union carried under a tool result's `content`. */
export const ToolResultBlock = Schema.Union([ToolResultTextBlock, ToolResultImageBlock])
export type ToolResultBlock = typeof ToolResultBlock.Type

/** Success schema shape for tools that return content blocks (read; extensible to others). */
export const ToolResultContent = Schema.Struct({
	content: Schema.Array(ToolResultBlock),
})
export type ToolResultContent = typeof ToolResultContent.Type

/** Build a single-text-block tool result. */
export const textResult = (text: string): ToolResultContent => ({ content: [{ type: 'text', text }] })
