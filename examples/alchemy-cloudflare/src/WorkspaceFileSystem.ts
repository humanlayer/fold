/**
 * Effect's `FileSystem` over a session's Computer, so fold's file tools and skill loader work on the
 * workspace unchanged. It covers what they call: reading, writing, making directories, removing,
 * `stat`, `access`, `exists`, `realPath` and listing a directory. Every other method is Effect's no-op.
 *
 * The workspace has no permissions, so `access` only checks the path exists. It has symlinks, but
 * `realPath` returns the path unchanged: fold only uses it to key its per-file write lock.
 */
import type { RpcCallError } from 'alchemy'
import { ByteSize, Effect, FileSystem, Option, PlatformError } from 'effect'

import type { FileInfo, ComputerResult } from './computer/Contract'

/** The Computer's file methods, as its RPC stub returns them. */
export type ComputerFiles = {
	readonly readFile: (path: string) => Effect.Effect<ComputerResult<Uint8Array>, RpcCallError>
	readonly writeFile: (path: string, content: string) => Effect.Effect<ComputerResult<null>, RpcCallError>
	readonly mkdir: (path: string, recursive: boolean) => Effect.Effect<ComputerResult<null>, RpcCallError>
	readonly rm: (path: string, recursive: boolean, force: boolean) => Effect.Effect<ComputerResult<null>, RpcCallError>
	readonly stat: (path: string) => Effect.Effect<ComputerResult<FileInfo>, RpcCallError>
	readonly readdir: (path: string) => Effect.Effect<ComputerResult<ReadonlyArray<string>>, RpcCallError>
}

const SYSTEM_ERROR_TAGS = new Map<string, PlatformError.SystemErrorTag>([
	['ENOENT', 'NotFound'],
	['EEXIST', 'AlreadyExists'],
	['EACCES', 'PermissionDenied'],
	['EPERM', 'PermissionDenied'],
	['EISDIR', 'BadResource'],
	['ENOTDIR', 'BadResource'],
	['EINVAL', 'InvalidData'],
])

/**
 * One Computer call as an Effect. A failed operation keeps its code in `cause.code`, where fold's tools
 * read it; a failed RPC is `Unknown`, so the tool call fails and the session goes on.
 */
const run = <A>(
	method: string,
	path: string,
	call: Effect.Effect<ComputerResult<A>, RpcCallError>,
): Effect.Effect<A, PlatformError.PlatformError> =>
	call.pipe(
		Effect.mapError((cause) =>
			PlatformError.systemError({
				_tag: 'Unknown',
				module: 'FileSystem',
				method,
				pathOrDescriptor: path,
				description: cause.message,
				cause,
			}),
		),
		Effect.flatMap((result) =>
			result.ok
				? Effect.succeed(result.value)
				: Effect.fail(
						PlatformError.systemError({
							_tag: SYSTEM_ERROR_TAGS.get(result.code) ?? 'Unknown',
							module: 'FileSystem',
							method,
							pathOrDescriptor: path,
							description: result.message,
							cause: { code: result.code },
						}),
					),
		),
		Effect.tap(() => Effect.logInfo('workspace.file').pipe(Effect.annotateLogs({ method, path, outcome: 'ok' }))),
		Effect.tapError((error) =>
			Effect.logInfo('workspace.file').pipe(
				Effect.annotateLogs({ method, path, outcome: error.reason._tag, error: error.message }),
			),
		),
	)

const toInfo = (info: FileInfo): FileSystem.File.Info => ({
	type: info.type,
	mtime: Option.some(new Date(info.mtime)),
	atime: Option.none(),
	birthtime: Option.none(),
	dev: 0,
	ino: Option.some(info.inode),
	mode: info.mode,
	nlink: Option.none(),
	uid: Option.none(),
	gid: Option.none(),
	rdev: Option.none(),
	size: ByteSize.bytes(info.size),
	blksize: Option.none(),
	blocks: Option.none(),
})

export const workspaceFileSystem = (computer: ComputerFiles): FileSystem.FileSystem => {
	const stat = (path: string) => run('stat', path, computer.stat(path)).pipe(Effect.map(toInfo))
	const readFile = (path: string) => run('readFile', path, computer.readFile(path))

	return FileSystem.makeNoop({
		readFile,
		readFileString: (path, encoding) =>
			Effect.flatMap(readFile(path), (bytes) =>
				Effect.try({
					try: () => new TextDecoder(encoding).decode(bytes),
					catch: (cause) =>
						PlatformError.badArgument({
							module: 'FileSystem',
							method: 'readFileString',
							description: 'invalid encoding',
							cause,
						}),
				}),
			),
		writeFileString: (path, data) => run('writeFileString', path, computer.writeFile(path, data)),
		makeDirectory: (path, options) => run('makeDirectory', path, computer.mkdir(path, options?.recursive ?? false)),
		remove: (path, options) =>
			run('remove', path, computer.rm(path, options?.recursive ?? false, options?.force ?? false)),
		stat,
		access: (path) => Effect.asVoid(stat(path)),
		exists: (path) =>
			stat(path).pipe(
				Effect.as(true),
				Effect.catchReasons('PlatformError', { NotFound: () => Effect.succeed(false) }),
			),
		realPath: (path) => Effect.as(stat(path), path),
		readDirectory: (path, options) =>
			options?.recursive === true
				? Effect.fail(
						PlatformError.badArgument({
							module: 'FileSystem',
							method: 'readDirectory',
							description: 'recursive listing is not supported',
						}),
					)
				: run('readDirectory', path, computer.readdir(path)).pipe(Effect.map((names) => [...names])),
	})
}
