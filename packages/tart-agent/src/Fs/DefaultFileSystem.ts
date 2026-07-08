/**
 * This file provides the default-or-override FileSystem seam every tart-agent tool uses: handlers close
 * over a FileSystem service implementation resolved at tool construction - the caller's override when
 * given (custom/in-memory filesystems for tests and sandboxes), otherwise the Node platform filesystem
 * built once per process. Effect v4 models defaultable services as `Context.Reference`, but platform
 * FileSystem is deliberately a required service with no default, so the fallback lives at this
 * descriptor seam instead (no `Layer` in any public signature, per the composition-root ruling).
 */
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Context, Effect, FileSystem, Layer } from 'effect'

/** Options shared by every filesystem-backed tool factory in tart-agent. */
export type FsToolOptions = {
	/** Working directory for resolving relative paths. Defaults to `process.cwd()` at call time. */
	readonly cwd?: string
	/** FileSystem implementation override. Defaults to the Node platform filesystem. */
	readonly fileSystem?: FileSystem.FileSystem
}

let nodeFileSystem: FileSystem.FileSystem | null = null

/** The process-wide Node FileSystem service, built lazily once (layer construction is synchronous). */
export const defaultNodeFileSystem = (): FileSystem.FileSystem => {
	if (nodeFileSystem === null) {
		nodeFileSystem = Effect.runSync(
			Effect.scoped(
				Layer.build(NodeFileSystem.layer).pipe(
					Effect.map((context) => Context.get(context, FileSystem.FileSystem)),
				),
			),
		)
	}

	return nodeFileSystem
}

/** Resolve the FileSystem a tool handler should use. */
export const fileSystemFor = (options?: FsToolOptions): FileSystem.FileSystem =>
	options?.fileSystem ?? defaultNodeFileSystem()

/** Resolve the working directory a tool handler should resolve relative paths against. */
export const cwdFor = (options?: FsToolOptions): string => options?.cwd ?? process.cwd()
