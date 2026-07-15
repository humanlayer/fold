/**
 * This file implements the apply_patch tool handler (D18): parse with the core engine (V4A per
 * opencode/agentlayer rules plus git/unified diffs), read every referenced file, dry-run the whole
 * patch in memory (validate-then-write atomicity - any failure means zero writes), then perform the
 * write/move/delete steps while holding every target file's mutation lock. Failure messages carry the
 * `apply_patch verification failed:` prefix (opencode/agentlayer convention).
 */
import { dirname } from 'node:path'

import {
	applyPatchToolContract,
	computePatch,
	defineTool,
	parsePatch,
	type PatchOp,
	type FoldTool,
} from '@humanlayer/fold-core'
import { Effect } from 'effect'

import { cwdFor, fileSystemFor, type FsToolOptions } from '../Fs/DefaultFileSystem'
import { withFileMutationLocks } from '../Fs/MutationQueue'
import { resolveToCwd } from '../Fs/PathResolve'
import { platformErrorMessage } from './ReadTool'

const verificationFailed = (detail: string): { message: string } => ({
	message: `apply_patch verification failed: ${detail}`,
})

/** Every path one op touches (move ops touch source and destination). */
const opPaths = (op: PatchOp): ReadonlyArray<string> =>
	op._tag === 'update' && op.movePath !== null ? [op.path, op.movePath] : [op.path]

/** Build the apply_patch tool over the default or provided filesystem. */
export const applyPatchTool = (options?: FsToolOptions): FoldTool =>
	defineTool({
		...applyPatchToolContract,
		handler: (params) =>
			Effect.gen(function* () {
				const fs = fileSystemFor(options)
				const cwd = cwdFor(options)
				const ops = yield* parsePatch(params.patch_text).pipe(
					Effect.mapError((error) => verificationFailed(error.message)),
				)

				const resolvePath = (path: string): string => resolveToCwd(path, cwd)
				const touchedPaths = [...new Set(ops.flatMap(opPaths).map(resolvePath))]

				// Hold every target's mutation lock across read-verify-write so parallel mutations of the
				// same files cannot interleave with the patch.
				return yield* withFileMutationLocks(
					fs,
					touchedPaths,
					Effect.gen(function* () {
						// Read every referenced file (null = does not exist) for the in-memory dry run.
						const files = new Map<string, string | null>()
						for (const op of ops) {
							if (op._tag === 'add') continue
							if (!files.has(op.path)) {
								const content = yield* fs
									.readFileString(resolvePath(op.path))
									.pipe(Effect.catch(() => Effect.succeed<string | null>(null)))
								files.set(op.path, content)
							}
						}

						const computed = yield* computePatch({ ops, files }).pipe(
							Effect.mapError((error) => verificationFailed(error.message)),
						)

						// Dry run passed: perform the steps. Writes create parent directories.
						for (const step of computed.steps) {
							switch (step._tag) {
								case 'write': {
									const target = resolvePath(step.path)
									yield* fs.makeDirectory(dirname(target), { recursive: true }).pipe(
										Effect.mapError((error) => ({
											message: platformErrorMessage('apply_patch', step.path, error),
										})),
									)
									yield* fs.writeFileString(target, step.content).pipe(
										Effect.mapError((error) => ({
											message: platformErrorMessage('apply_patch', step.path, error),
										})),
									)
									break
								}

								case 'delete':
									yield* fs.remove(resolvePath(step.path)).pipe(
										Effect.mapError((error) => ({
											message: platformErrorMessage('apply_patch', step.path, error),
										})),
									)
									break

								case 'move': {
									const target = resolvePath(step.toPath)
									yield* fs.makeDirectory(dirname(target), { recursive: true }).pipe(
										Effect.mapError((error) => ({
											message: platformErrorMessage('apply_patch', step.toPath, error),
										})),
									)
									yield* fs.writeFileString(target, step.content).pipe(
										Effect.mapError((error) => ({
											message: platformErrorMessage('apply_patch', step.toPath, error),
										})),
									)
									yield* fs.remove(resolvePath(step.fromPath)).pipe(
										Effect.mapError((error) => ({
											message: platformErrorMessage('apply_patch', step.fromPath, error),
										})),
									)
									break
								}
							}
						}

						return { message: `Applied patch.\n${computed.summary.join('\n')}` }
					}),
				).pipe(
					Effect.catchTag('PlatformError', (error) =>
						Effect.fail(verificationFailed(platformErrorMessage('apply_patch', 'patch target', error))),
					),
				)
			}),
	})
