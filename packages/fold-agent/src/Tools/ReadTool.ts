/**
 * This file implements the read tool handler (D18, pi port) over the FileSystem seam: text files are
 * head-truncated lines with right-aligned line-number prefixes and pi's continuation notices and
 * 1-indexed offset/limit; images (the ticket's hard requirement) are magic-byte sniffed, normalized,
 * auto-resized, and returned as an image content block that RequestBuilder delivers as a native user
 * file part (D3). Binary and malformed UTF-8 files are rejected with typed model-visible failures.
 */
import {
	defineTool,
	formatSize,
	defaultMaxBytes,
	platformToolDependencies,
	readToolContract,
	ToolResultFailure,
	ToolResultImagePart,
	ToolResultMultipart,
	ToolResultText,
	ToolResultTextPart,
	truncateHead,
	type FoldTool,
} from '@humanlayer/fold-core'
import { Effect, FileSystem, Match, Schema, type PlatformError } from 'effect'

import { resolveReadPath, resolveToCwd } from '../Fs/PathResolve'
import { detectSupportedImageMimeType, imageSniffBytes } from './Image/Mime'
import { processImage } from './Image/Process'

const binaryFileExtensions = new Set([
	'.zip',
	'.tar',
	'.gz',
	'.exe',
	'.dll',
	'.so',
	'.class',
	'.jar',
	'.war',
	'.7z',
	'.doc',
	'.docx',
	'.xls',
	'.xlsx',
	'.ppt',
	'.pptx',
	'.odt',
	'.ods',
	'.odp',
	'.pdf',
	'.bin',
	'.dat',
	'.obj',
	'.o',
	'.a',
	'.lib',
	'.wasm',
	'.pyc',
	'.pyo',
])

const binaryDetectionSampleBytes = 4_096

/** Match OpenCode's extension and control-byte heuristic for model-facing text reads. */
const isBinaryFile = (path: string, bytes: Uint8Array): boolean => {
	const extensionStart = path.lastIndexOf('.')
	if (extensionStart !== -1 && binaryFileExtensions.has(path.slice(extensionStart).toLowerCase())) return true

	const sample = bytes.subarray(0, binaryDetectionSampleBytes)
	if (sample.length === 0) return false

	let nonPrintableBytes = 0
	for (const byte of sample) {
		if (byte === 0) return true
		if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) nonPrintableBytes += 1
	}

	return nonPrintableBytes / sample.length > 0.3
}

const decodeTextFile = (path: string, bytes: Uint8Array): Effect.Effect<string, ToolResultFailure> => {
	if (isBinaryFile(path, bytes) || bytes.includes(0)) {
		return Effect.fail(ToolResultFailure.make({ text: `Cannot read binary file: ${path}` }))
	}

	return Effect.try({
		try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
		catch: () => ToolResultFailure.make({ text: `Cannot read file because it is not valid UTF-8: ${path}` }),
	})
}

/** Render one platform error as a short, model-actionable failure message. */
export const platformErrorMessage = (action: string, path: string, error: PlatformError.PlatformError): string => {
	return Match.value(error.reason).pipe(
		Match.tags({
			NotFound: () => `${action} failed: file not found: ${path}`,
			PermissionDenied: () => `${action} failed: permission denied: ${path}`,
			BadResource: () => `${action} failed: not a readable file (is it a directory?): ${path}`,
		}),
		Match.orElse((reason) => `${action} failed (${reason._tag}): ${path}`),
	)
}

/** Extract the POSIX errno code (ENOENT, EACCES, ...) from a platform error, pi's error vocabulary. */
export const errnoCode = (error: PlatformError.PlatformError): string => {
	const cause: unknown = error.reason.cause
	if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string') {
		return cause.code
	}

	return Match.value(error.reason).pipe(
		Match.tags({ NotFound: () => 'ENOENT', PermissionDenied: () => 'EACCES' }),
		Match.orElse((reason) => reason._tag),
	)
}

/** Build the read tool over the ambient FileSystem service. */
export const readTool = (options?: { readonly cwd?: string }): FoldTool =>
	defineTool({
		...readToolContract,
		dependencies: platformToolDependencies,
		handler: (params) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const cwd = yield* resolveToCwd(options?.cwd ?? process.cwd(), process.cwd())
				const absolutePath = yield* resolveReadPath(params.path, cwd, fs)

				const bytes = yield* fs
					.readFile(absolutePath)
					.pipe(
						Effect.mapError((error) =>
							ToolResultFailure.make({ text: platformErrorMessage('read', params.path, error) }),
						),
					)

				const imageMimeType = detectSupportedImageMimeType(bytes.subarray(0, imageSniffBytes))
				if (imageMimeType !== null) {
					const processed = yield* Effect.promise(() => processImage(bytes, imageMimeType))

					if (!processed.ok) {
						return ToolResultText.make({
							text: `Read image file [${imageMimeType}]\n${processed.message}`,
						})
					}

					const note = [`Read image file [${processed.mimeType}]`, ...processed.hints].join('\n')
					return ToolResultMultipart.make({
						content: [
							ToolResultTextPart.make({ text: note }),
							ToolResultImagePart.make({ data: processed.data, mediaType: processed.mimeType }),
						],
					})
				}

				const text = yield* decodeTextFile(params.path, bytes)
				return yield* readTextContent(text, params)
			}).pipe(
				Effect.mapError((error) =>
					Schema.is(ToolResultFailure)(error) ? error : ToolResultFailure.make({ text: error.message }),
				),
			),
	})

/** Prefix text lines with right-aligned, 1-indexed line numbers and an arrow separator. */
const numberTextLines = (content: string, startLine: number, outputLines: number): string => {
	const width = String(startLine + outputLines - 1).length
	return content
		.split('\n')
		.map((line, index) => `${String(startLine + index).padStart(width, ' ')}→${line}`)
		.join('\n')
}

/** Read the text path: offset/limit selection, head truncation, line numbering, and continuation notices. */
const readTextContent = (
	text: string,
	params: { readonly path: string; readonly offset?: number | undefined; readonly limit?: number | undefined },
): Effect.Effect<ToolResultText, ToolResultFailure> =>
	Effect.gen(function* () {
		const allLines = text.split('\n')
		const startLine = params.offset !== undefined && params.offset > 0 ? Math.max(0, params.offset - 1) : 0
		const startLineDisplay = startLine + 1

		if (startLine >= allLines.length) {
			return yield* Effect.fail(
				ToolResultFailure.make({
					text: `Offset ${params.offset} is beyond end of file (${allLines.length} lines total)`,
				}),
			)
		}

		const userLimited = params.limit !== undefined
		const selectedLines = userLimited
			? allLines.slice(startLine, startLine + Math.max(params.limit ?? 0, 0))
			: allLines.slice(startLine)
		const selectedContent = selectedLines.join('\n')

		const truncation = truncateHead(selectedContent)

		if (truncation.firstLineExceedsLimit) {
			const firstLineSize = formatSize(new TextEncoder().encode(allLines[startLine] ?? '').length)
			return ToolResultText.make({
				text: `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(defaultMaxBytes)} limit. Use bash: sed -n '${startLineDisplay}p' ${params.path} | head -c ${defaultMaxBytes}]`,
			})
		}

		let outputText = numberTextLines(truncation.content, startLineDisplay, truncation.outputLines)
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1
		const nextOffset = endLineDisplay + 1
		const totalFileLines = allLines.length

		if (truncation.truncated) {
			outputText +=
				truncation.truncatedBy === 'lines'
					? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
					: `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(defaultMaxBytes)} limit). Use offset=${nextOffset} to continue.]`
		} else if (userLimited && startLine + selectedLines.length < totalFileLines) {
			const remaining = totalFileLines - (startLine + selectedLines.length)
			outputText += `\n\n[${remaining} more lines in file. Use offset=${startLine + selectedLines.length + 1} to continue.]`
		}

		return ToolResultText.make({ text: outputText })
	})
