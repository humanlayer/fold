/**
 * This file implements the edit tool handler (D18, pi port): input normalization (batch, JSON-string
 * edits, legacy single pair) through the core engine's shim, the exact-then-normalized matching engine
 * over the file's content, and a serialized read-modify-write through the per-file mutation queue so
 * parallel edits of one file cannot interleave.
 */
import {
	defineTool,
	applyEdits,
	editToolContract,
	normalizeEditInput,
	platformToolDependencies,
	ToolResultFailure,
	ToolResultText,
	type FoldTool,
} from '@humanlayer/fold-core'
import { Effect, FileSystem } from 'effect'

import { withFileMutationLock } from '../Fs/MutationQueue'
import { resolveToCwd } from '../Fs/PathResolve'
import { errnoCode, platformErrorMessage } from './ReadTool'

/** Build the edit tool over the ambient FileSystem service. */
export const editTool = (options?: { readonly cwd?: string }): FoldTool =>
	defineTool({
		...editToolContract,
		dependencies: platformToolDependencies,
		handler: (params) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const cwd = yield* resolveToCwd(options?.cwd ?? process.cwd(), process.cwd())
				const absolutePath = yield* resolveToCwd(params.path, cwd)
				const edits = yield* normalizeEditInput(params).pipe(
					Effect.mapError((error) => ({ message: error.message })),
				)

				// pi gates on read+write access before matching, with its verbatim error shape.
				yield* fs.access(absolutePath, { readable: true, writable: true }).pipe(
					Effect.mapError((error) => ({
						message: `Could not edit file: ${params.path}. Error code: ${errnoCode(error)}.`,
					})),
				)

				// Read, match, and write under the same lock: the matched content must be the written base.
				const outcome = yield* withFileMutationLock(
					fs,
					absolutePath,
					Effect.gen(function* () {
						const rawContent = yield* fs.readFileString(absolutePath).pipe(
							Effect.mapError((error) => ({
								message: platformErrorMessage('edit', params.path, error),
							})),
						)
						const applied = yield* applyEdits({ rawContent, edits, path: params.path }).pipe(
							Effect.mapError((error) => ({ message: error.message })),
						)

						yield* fs.writeFileString(absolutePath, applied.content).pipe(
							Effect.mapError((error) => ({
								message: platformErrorMessage('edit', params.path, error),
							})),
						)

						return applied
					}),
				).pipe(
					Effect.catchTag('PlatformError', (error) =>
						Effect.fail({
							message: `Could not edit file: ${params.path}. Error code: ${errnoCode(error)}.`,
						}),
					),
				)

				return ToolResultText.make({
					text: `Successfully replaced ${outcome.editsApplied} block(s) in ${params.path}.`,
				})
			}).pipe(Effect.mapError((error) => ToolResultFailure.make({ text: error.message }))),
	})
