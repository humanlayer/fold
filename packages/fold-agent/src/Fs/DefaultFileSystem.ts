import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Context, Effect, FileSystem, Layer } from 'effect'

let nodeFileSystem: FileSystem.FileSystem | null = null

const defaultNodeFileSystem = (): FileSystem.FileSystem => {
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

/** Resolve the filesystem a handler should use. */
export const fileSystemFor = (options?: { readonly fileSystem?: FileSystem.FileSystem }): FileSystem.FileSystem =>
	options?.fileSystem ?? defaultNodeFileSystem()

/** Resolve the working directory a tool handler should resolve relative paths against. */
export const cwdFor = (options?: { readonly cwd?: string }): string => options?.cwd ?? process.cwd()
