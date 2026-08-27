/**
 * This file implements the apply_patch tool handler (D18): parse with the core engine (V4A per
 * opencode/agentlayer rules plus git/unified diffs), read every referenced file, dry-run the whole
 * patch in memory (validate-then-write atomicity - any failure means zero writes), then perform the
 * write/move/delete steps while holding every target file's mutation lock. Failure messages carry the
 * `apply_patch verification failed:` prefix (opencode/agentlayer convention).
 */
import {
	applyPatchToolContract,
	computePatch,
	defineTool,
	parsePatch,
	platformToolDependencies,
	type PatchOp,
	type FoldTool,
} from '@humanlayer/fold-core'
import { Match, Predicate, Effect, FileSystem, Path } from 'effect'

import { withFileMutationLocks } from '../Fs/MutationQueue'
import { resolveToCwd } from '../Fs/PathResolve'
import { platformErrorMessage } from './ReadTool'

const verificationFailed = (detail: string): { message: string } => ({
	message: `apply_patch verification failed: ${detail}`,
})

/** Every path one op touches (move ops touch source and destination). */
const opPaths = (op: PatchOp): ReadonlyArray<string> =>
	Predicate.isTagged(op, 'update') && op.movePath !== null ? [op.path, op.movePath] : [op.path]

/** Build the apply_patch tool over the ambient FileSystem service. */
export const applyPatchTool = (options?: { readonly cwd?: string }): FoldTool =>
	defineTool({
		...applyPatchToolContract,
		dependencies: platformToolDependencies,
		handler: (params) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const pathService = yield* Path.Path
				const cwd = yield* resolveToCwd(options?.cwd ?? process.cwd(), process.cwd())
				const ops = yield* parsePatch(params.patch_text).pipe(
					Effect.mapError((error) => verificationFailed(error.message)),
				)

				const resolvePath = (path: string) => resolveToCwd(path, cwd)
				const touchedPaths = [...new Set(yield* Effect.forEach(ops.flatMap(opPaths), resolvePath))]

				// Hold every target's mutation lock across read-verify-write so parallel mutations of the
				// same files cannot interleave with the patch.
				return yield* withFileMutationLocks(
					fs,
					touchedPaths,
					Effect.gen(function* () {
						// Read every referenced file (null = does not exist) for the in-memory dry run.
						const files = new Map<string, string | null>()
						for (const op of ops) {
							if (Predicate.isTagged(op, 'add')) continue
							if (!files.has(op.path)) {
								const source = yield* resolvePath(op.path)
								const content = yield* fs
									.readFileString(source)
									.pipe(Effect.catch(() => Effect.succeed<string | null>(null)))
								files.set(op.path, content)
							}
						}

						const computed = yield* computePatch({ ops, files }).pipe(
							Effect.mapError((error) => verificationFailed(error.message)),
						)

						// Dry run passed: perform the steps. Writes create parent directories.
						for (const step of computed.steps) {
							yield* Match.valueTags(step, {
								write: (write) =>
									Effect.gen(function* () {
										const target = yield* resolvePath(write.path)
										yield* fs.makeDirectory(pathService.dirname(target), { recursive: true }).pipe(
											Effect.mapError((error) => ({
												message: platformErrorMessage('apply_patch', write.path, error),
											})),
										)
										yield* fs.writeFileString(target, write.content).pipe(
											Effect.mapError((error) => ({
												message: platformErrorMessage('apply_patch', write.path, error),
											})),
										)
									}),
								delete: (deletion) =>
									resolvePath(deletion.path).pipe(
										Effect.flatMap((path) =>
											fs.remove(path).pipe(
												Effect.mapError((error) => ({
													message: platformErrorMessage('apply_patch', deletion.path, error),
												})),
											),
										),
									),
								move: (move) =>
									Effect.gen(function* () {
										const target = yield* resolvePath(move.toPath)
										yield* fs.makeDirectory(pathService.dirname(target), { recursive: true }).pipe(
											Effect.mapError((error) => ({
												message: platformErrorMessage('apply_patch', move.toPath, error),
											})),
										)
										yield* fs.writeFileString(target, move.content).pipe(
											Effect.mapError((error) => ({
												message: platformErrorMessage('apply_patch', move.toPath, error),
											})),
										)
										yield* fs.remove(yield* resolvePath(move.fromPath)).pipe(
											Effect.mapError((error) => ({
												message: platformErrorMessage('apply_patch', move.fromPath, error),
											})),
										)
									}),
							})
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
