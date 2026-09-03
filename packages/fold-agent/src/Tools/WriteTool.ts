/**
 * This file implements the write tool handler (D18, pi port): full overwrite with recursive parent
 * directory creation, serialized through the per-file mutation queue. One deliberate deviation from pi
 * (per D18): the success message reports the true UTF-8 byte count, not the UTF-16 code-unit length.
 */
import {
	defineTool,
	platformToolDependencies,
	ToolResultFailure,
	ToolResultText,
	utf8ByteLength,
	writeToolContract,
	type FoldTool,
} from '@humanlayer/fold-core'
import { Effect, FileSystem, Path } from 'effect'

import { withFileMutationLock } from '../Fs/MutationQueue'
import { resolveToCwd } from '../Fs/PathResolve'
import { platformErrorMessage } from './ReadTool'

/** Build the write tool over the ambient FileSystem service. */
export const writeTool = (options?: { readonly cwd?: string }): FoldTool =>
	defineTool({
		...writeToolContract,
		dependencies: platformToolDependencies,
		handler: (params) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const pathService = yield* Path.Path
				const cwd = yield* resolveToCwd(options?.cwd ?? process.cwd(), process.cwd())
				const absolutePath = yield* resolveToCwd(params.path, cwd)

				yield* withFileMutationLock(
					fs,
					absolutePath,
					Effect.gen(function* () {
						yield* fs.makeDirectory(pathService.dirname(absolutePath), { recursive: true }).pipe(
							Effect.mapError((error) => ({
								message: platformErrorMessage('write', params.path, error),
							})),
						)
						yield* fs.writeFileString(absolutePath, params.content).pipe(
							Effect.mapError((error) => ({
								message: platformErrorMessage('write', params.path, error),
							})),
						)
					}),
				).pipe(
					// Realpath failures while keying the lock (permissions, symlink loops) surface too.
					Effect.catchTag('PlatformError', (error) =>
						Effect.fail({ message: platformErrorMessage('write', params.path, error) }),
					),
				)

				return ToolResultText.make({
					text: `Successfully wrote ${utf8ByteLength(params.content)} bytes to ${params.path}`,
				})
			}).pipe(Effect.mapError((error) => ToolResultFailure.make({ text: error.message }))),
	})
