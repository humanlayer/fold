/**
 * This file implements the shared output-truncation engine for built-in tools (D18/D19): head
 * truncation for read (the model continues with offset), tail truncation for bash (errors live at the
 * end). Ported from pi's truncate.ts semantics: dual limits (2000 lines / 50KB, first hit wins), no
 * partial lines except the explicit oversized-single-line cases, UTF-8-boundary-safe byte trimming,
 * and pi's line counting (a trailing newline terminates the last line rather than starting an empty
 * one). Truncation happens exactly once, at result creation; the truncated text is then immortal in
 * log and prompt (the prefix-stability rule).
 */

/** Default line limit shared by read and bash truncation (pi parity). */
export const defaultMaxLines = 2000

/** Default byte limit shared by read and bash truncation (pi parity: 50KB). */
export const defaultMaxBytes = 50 * 1024

const encoder = new TextEncoder()

/** Count the true UTF-8 byte length of a string (isomorphic Buffer.byteLength). */
export const utf8ByteLength = (text: string): number => encoder.encode(text).length

/** Render a byte count the way pi does: `512B`, `50.0KB`, `1.2MB`. */
export const formatSize = (bytes: number): string => {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Split for line counting (pi's `splitLinesForCounting`): empty text has zero lines, and a trailing
 * newline terminates the final line instead of opening an empty one.
 */
export const splitLinesForCounting = (text: string): ReadonlyArray<string> => {
	if (text.length === 0) return []
	const lines = text.split('\n')
	if (lines[lines.length - 1] === '') lines.pop()
	return lines
}

/** Options for {@link truncateHead} and {@link truncateTail}. */
export type TruncateOptions = {
	readonly maxLines?: number
	readonly maxBytes?: number
}

/** Result of one truncation pass over a text block. */
export type TruncationResult = {
	readonly content: string
	readonly truncated: boolean
	/** Which limit cut the output; null when not truncated. */
	readonly truncatedBy: 'lines' | 'bytes' | null
	/** Number of lines present in `content`. */
	readonly outputLines: number
	/** Number of lines in the original text (trailing newline does not count as a line). */
	readonly totalLines: number
	/** Head only: the very first line alone exceeds the byte limit, so `content` is empty. */
	readonly firstLineExceedsLimit: boolean
	/** Tail only: the final line alone exceeded the byte limit, so `content` is its byte-cut tail. */
	readonly lastLinePartial: boolean
}

/**
 * Keep the first lines of `text` within the line and byte limits (read's direction). Content within
 * both limits passes through byte-identical (trailing newline preserved). Never emits a partial line:
 * when the first line alone exceeds the byte limit, `content` is empty and `firstLineExceedsLimit` is
 * set so the caller can redirect the model to bash (pi's split).
 */
export const truncateHead = (text: string, options?: TruncateOptions): TruncationResult => {
	const maxLines = options?.maxLines ?? defaultMaxLines
	const maxBytes = options?.maxBytes ?? defaultMaxBytes
	const lines = splitLinesForCounting(text)

	// Within both limits: pass the original text through untouched (pi's early return).
	if (lines.length <= maxLines && utf8ByteLength(text) <= maxBytes) {
		return {
			content: text,
			truncated: false,
			truncatedBy: null,
			outputLines: lines.length,
			totalLines: lines.length,
			firstLineExceedsLimit: false,
			lastLinePartial: false,
		}
	}

	if (lines.length > 0 && utf8ByteLength(lines[0] ?? '') > maxBytes) {
		return {
			content: '',
			truncated: true,
			truncatedBy: 'bytes',
			outputLines: 0,
			totalLines: lines.length,
			firstLineExceedsLimit: true,
			lastLinePartial: false,
		}
	}

	const kept: Array<string> = []
	let bytes = 0
	let truncatedBy: 'lines' | 'bytes' | null = null

	for (const line of lines) {
		if (kept.length >= maxLines) {
			truncatedBy = 'lines'
			break
		}

		const lineBytes = utf8ByteLength(line) + (kept.length > 0 ? 1 : 0)
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = 'bytes'
			break
		}

		kept.push(line)
		bytes += lineBytes
	}

	return {
		content: kept.join('\n'),
		truncated: truncatedBy !== null,
		truncatedBy,
		outputLines: kept.length,
		totalLines: lines.length,
		firstLineExceedsLimit: false,
		lastLinePartial: false,
	}
}

/** Trim a string to at most `maxBytes` UTF-8 bytes, keeping the tail and never splitting a code point. */
const tailBytes = (text: string, maxBytes: number): string => {
	const encoded = encoder.encode(text)
	if (encoded.length <= maxBytes) return text

	let start = encoded.length - maxBytes
	// Skip UTF-8 continuation bytes so the cut lands on a code-point boundary.
	while (start < encoded.length && ((encoded[start] ?? 0) & 0xc0) === 0x80) start += 1

	return new TextDecoder().decode(encoded.subarray(start))
}

/**
 * Keep the last lines of `text` within the line and byte limits (bash's direction - errors live at the
 * end). When the final line alone exceeds the byte limit, its tail bytes are kept (pi's
 * `lastLinePartial` case), cut on a UTF-8 boundary.
 */
export const truncateTail = (text: string, options?: TruncateOptions): TruncationResult => {
	const maxLines = options?.maxLines ?? defaultMaxLines
	const maxBytes = options?.maxBytes ?? defaultMaxBytes
	const lines = splitLinesForCounting(text)

	if (lines.length <= maxLines && utf8ByteLength(text) <= maxBytes) {
		return {
			content: text,
			truncated: false,
			truncatedBy: null,
			outputLines: lines.length,
			totalLines: lines.length,
			firstLineExceedsLimit: false,
			lastLinePartial: false,
		}
	}

	const lastLine = lines[lines.length - 1] ?? ''
	if (utf8ByteLength(lastLine) > maxBytes) {
		return {
			content: tailBytes(lastLine, maxBytes),
			truncated: true,
			truncatedBy: 'bytes',
			outputLines: 1,
			totalLines: lines.length,
			firstLineExceedsLimit: false,
			lastLinePartial: true,
		}
	}

	const kept: Array<string> = []
	let bytes = 0
	let truncatedBy: 'lines' | 'bytes' | null = null

	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (kept.length >= maxLines) {
			truncatedBy = 'lines'
			break
		}

		const line = lines[index] ?? ''
		const lineBytes = utf8ByteLength(line) + (kept.length > 0 ? 1 : 0)
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = 'bytes'
			break
		}

		kept.unshift(line)
		bytes += lineBytes
	}

	return {
		content: kept.join('\n'),
		truncated: truncatedBy !== null,
		truncatedBy,
		outputLines: kept.length,
		totalLines: lines.length,
		firstLineExceedsLimit: false,
		lastLinePartial: false,
	}
}
