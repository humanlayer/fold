/**
 * This file implements the read tool handler (D18, pi port) over the FileSystem seam: text files are
 * head-truncated raw lines (no line-number prefixes) with pi's verbatim continuation notices and
 * 1-indexed offset/limit; images (the ticket's hard requirement) are magic-byte sniffed, normalized,
 * auto-resized, and returned as an image content block that RequestBuilder delivers as a native user
 * file part (D3). Errors are typed model-visible failures.
 */
import {
	defineTool,
	formatSize,
	defaultMaxBytes,
	readToolContract,
	truncateHead,
	type TartTool,
	type ToolResultBlock,
} from '@humanlayer/tart-core'
import { Effect, type PlatformError } from 'effect'

import { cwdFor, fileSystemFor, type FsToolOptions } from '../Fs/DefaultFileSystem'
import { resolveReadPath } from '../Fs/PathResolve'
import { detectSupportedImageMimeType, imageSniffBytes } from './Image/Mime'
import { processImage } from './Image/Process'

/** Render one platform error as a short, model-actionable failure message. */
export const platformErrorMessage = (action: string, path: string, error: PlatformError.PlatformError): string => {
	switch (error.reason._tag) {
		case 'NotFound':
			return `${action} failed: file not found: ${path}`
		case 'PermissionDenied':
			return `${action} failed: permission denied: ${path}`
		case 'BadResource':
			return `${action} failed: not a readable file (is it a directory?): ${path}`
		default:
			return `${action} failed (${error.reason._tag}): ${path}`
	}
}

/** Extract the POSIX errno code (ENOENT, EACCES, ...) from a platform error, pi's error vocabulary. */
export const errnoCode = (error: PlatformError.PlatformError): string => {
	const cause: unknown = error.reason.cause
	if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string') {
		return cause.code
	}

	switch (error.reason._tag) {
		case 'NotFound':
			return 'ENOENT'
		case 'PermissionDenied':
			return 'EACCES'
		default:
			return error.reason._tag
	}
}

/** Build the read tool over the default or provided filesystem. */
export const readTool = (options?: FsToolOptions): TartTool =>
	defineTool({
		...readToolContract,
		handler: (params) =>
			Effect.gen(function* () {
				const fs = fileSystemFor(options)
				const cwd = cwdFor(options)
				const absolutePath = yield* resolveReadPath(params.path, cwd, fs)

				const bytes = yield* fs
					.readFile(absolutePath)
					.pipe(Effect.mapError((error) => ({ message: platformErrorMessage('read', params.path, error) })))

				const imageMimeType = detectSupportedImageMimeType(bytes.subarray(0, imageSniffBytes))
				if (imageMimeType !== null) {
					const processed = yield* Effect.promise(() => processImage(bytes, imageMimeType))

					if (!processed.ok) {
						return {
							content: [
								{
									type: 'text' as const,
									text: `Read image file [${imageMimeType}]\n${processed.message}`,
								},
							],
						}
					}

					const note = [`Read image file [${processed.mimeType}]`, ...processed.hints].join('\n')
					const blocks: Array<ToolResultBlock> = [
						{ type: 'text', text: note },
						{ type: 'image', data: processed.data, mimeType: processed.mimeType },
					]
					return { content: blocks }
				}

				return yield* readTextContent(bytes, params)
			}),
	})

/** Read the text path: offset/limit selection, head truncation, and pi's verbatim notices. */
const readTextContent = (
	bytes: Uint8Array,
	params: { readonly path: string; readonly offset?: number | undefined; readonly limit?: number | undefined },
): Effect.Effect<{ content: ReadonlyArray<ToolResultBlock> }, { message: string }> =>
	Effect.gen(function* () {
		const allLines = new TextDecoder().decode(bytes).split('\n')
		const startLine = params.offset !== undefined && params.offset > 0 ? Math.max(0, params.offset - 1) : 0
		const startLineDisplay = startLine + 1

		if (startLine >= allLines.length) {
			return yield* Effect.fail({
				message: `Offset ${params.offset} is beyond end of file (${allLines.length} lines total)`,
			})
		}

		const userLimited = params.limit !== undefined
		const selectedLines = userLimited
			? allLines.slice(startLine, startLine + Math.max(params.limit ?? 0, 0))
			: allLines.slice(startLine)
		const selectedContent = selectedLines.join('\n')

		const truncation = truncateHead(selectedContent)

		if (truncation.firstLineExceedsLimit) {
			const firstLineSize = formatSize(new TextEncoder().encode(allLines[startLine] ?? '').length)
			return {
				content: [
					{
						type: 'text' as const,
						text: `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(defaultMaxBytes)} limit. Use bash: sed -n '${startLineDisplay}p' ${params.path} | head -c ${defaultMaxBytes}]`,
					},
				],
			}
		}

		let outputText = truncation.content
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

		return { content: [{ type: 'text' as const, text: outputText }] }
	})
