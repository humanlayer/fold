/**
 * This file implements the per-file mutation queue (D18, pi's file-mutation-queue port): write, edit,
 * and apply_patch serialize per target file so parallel tool calls cannot corrupt one file, while
 * different files still mutate in parallel. Keys are realpaths so symlink aliases share one queue;
 * files that do not exist yet fall back to their resolved path. The queue is in-process only (no
 * cross-process locking), matching pi.
 */
import { resolve } from 'node:path'

import { Effect, Semaphore, type FileSystem, type PlatformError } from 'effect'

type QueueEntry = {
	readonly semaphore: Semaphore.Semaphore
	holders: number
}

const queues = new Map<string, QueueEntry>()
// Serializes map registration so two concurrent callers cannot race a key into existence twice.
const registration = Effect.runSync(Semaphore.make(1))

/**
 * Compute the queue key: realpath when the file exists, resolved absolute path when it does not exist
 * yet. Other realpath failures (permissions, symlink loops) propagate - pi rethrows them too.
 */
const queueKey = (fs: FileSystem.FileSystem, path: string): Effect.Effect<string, PlatformError.PlatformError> => {
	const resolved = resolve(path)

	return fs.realPath(resolved).pipe(
		Effect.catchIf(
			(error) => error.reason._tag === 'NotFound' || error.reason._tag === 'BadResource',
			() => Effect.succeed(resolved),
		),
	)
}

const acquireEntry = (key: string): Effect.Effect<QueueEntry> =>
	registration.withPermit(
		Effect.gen(function* () {
			const existing = queues.get(key)
			if (existing !== undefined) {
				existing.holders += 1
				return existing
			}

			const entry: QueueEntry = { semaphore: yield* Semaphore.make(1), holders: 1 }
			queues.set(key, entry)
			return entry
		}),
	)

const releaseEntry = (key: string, entry: QueueEntry): Effect.Effect<void> =>
	registration.withPermit(
		Effect.sync(() => {
			entry.holders -= 1
			if (entry.holders <= 0) queues.delete(key)
		}),
	)

/**
 * Run `work` while holding this file's mutation lock. Same key runs FIFO one-at-a-time; different keys
 * run in parallel. The lock is released (and the map entry cleaned up) whether the work succeeds,
 * fails, or is interrupted.
 */
export const withFileMutationLock = <A, E, R>(
	fs: FileSystem.FileSystem,
	path: string,
	work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PlatformError.PlatformError, R> =>
	Effect.gen(function* () {
		const key = yield* queueKey(fs, path)
		const entry = yield* acquireEntry(key)

		return yield* entry.semaphore.withPermit(work).pipe(Effect.ensuring(releaseEntry(key, entry)))
	})

/**
 * Run `work` while holding the mutation locks of several files at once (apply_patch touches many).
 * Keys are acquired in sorted order so two overlapping multi-file mutations cannot deadlock.
 */
export const withFileMutationLocks = <A, E, R>(
	fs: FileSystem.FileSystem,
	paths: ReadonlyArray<string>,
	work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PlatformError.PlatformError, R> =>
	Effect.gen(function* () {
		const keys = [...new Set(yield* Effect.forEach(paths, (path) => queueKey(fs, path)))].sort()

		let locked = work
		for (const key of [...keys].reverse()) {
			const inner = locked
			locked = Effect.gen(function* () {
				const entry = yield* acquireEntry(key)
				return yield* entry.semaphore.withPermit(inner).pipe(Effect.ensuring(releaseEntry(key, entry)))
			})
		}

		return yield* locked
	})
