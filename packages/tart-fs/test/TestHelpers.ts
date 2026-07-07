/**
 * Shared fixtures for tart-fs tool tests: ambient tool services (recorded ToolEvents, no-op
 * ToolState/StopController), scoped temp directories on the real filesystem, and an in-memory
 * FileSystem built on `FileSystem.makeNoop` for tests that must not touch the user's disk (skill scan
 * paths reach the home directory).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'

import { StopController, ToolEvents, ToolState, type ToolHandlerServices } from '@humanlayer/tart-core'
import { Effect, FileSystem, Layer, PlatformError, Ref, Schema } from 'effect'

/** Run a tool handler effect with stubbed ambient services and a recorded ToolEvents feed. */
export const makeAmbientServices = (): Effect.Effect<{
	readonly layer: Layer.Layer<ToolState | ToolEvents | StopController>
	readonly emitted: Effect.Effect<ReadonlyArray<typeof Schema.Json.Type>>
}> =>
	Effect.gen(function* () {
		const events = yield* Ref.make<ReadonlyArray<typeof Schema.Json.Type>>([])

		return {
			layer: Layer.mergeAll(
				Layer.succeed(ToolState, { get: () => Effect.succeed(null), set: () => Effect.void }),
				Layer.succeed(ToolEvents, {
					emit: (payload) => Ref.update(events, (recorded) => [...recorded, payload]),
				}),
				Layer.succeed(StopController, {
					requestStop: () => Effect.void,
					isStopRequested: Effect.succeed(false),
				}),
			),
			emitted: Ref.get(events),
		}
	})

/** Run one handler with throwaway ambient services. */
export const runHandler = <A, E>(effect: Effect.Effect<A, E, ToolHandlerServices>): Effect.Effect<A, E> =>
	Effect.gen(function* () {
		const ambient = yield* makeAmbientServices()
		return yield* effect.pipe(Effect.provide(ambient.layer))
	})

/** A scoped temp directory on the real filesystem, removed when the scope closes. */
export const tempDir = Effect.acquireRelease(
	Effect.sync(() => mkdtempSync(join(tmpdir(), 'tart-fs-test-'))),
	(directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
)

const notFound = (method: string, path: string) =>
	PlatformError.systemError({
		_tag: 'NotFound',
		module: 'FileSystem',
		method,
		pathOrDescriptor: path,
	})

/**
 * An in-memory FileSystem over a path -> content map (directories are implied by file paths). Enough
 * surface for the skill loader and read-only tool paths; unsupported operations keep makeNoop's
 * defect-on-use behavior so accidental writes fail loudly instead of touching the disk.
 */
export const memoryFileSystem = (initialFiles: Record<string, string>): FileSystem.FileSystem => {
	const files = new Map<string, string>(
		Object.entries(initialFiles).map(([path, content]) => [normalize(path), content]),
	)

	const isDirectory = (path: string): boolean => {
		const prefix = path.endsWith('/') ? path : `${path}/`
		return [...files.keys()].some((filePath) => filePath.startsWith(prefix))
	}

	const statFor = (path: string): Effect.Effect<FileSystem.File.Info, PlatformError.PlatformError> => {
		const target = normalize(path)
		const type = files.has(target) ? 'File' : isDirectory(target) ? 'Directory' : null
		if (type === null) return Effect.fail(notFound('stat', target))

		// Only `type` is consulted by the code under test; the remaining fields are inert placeholders.
		// oxlint-disable-next-line typescript/consistent-type-assertions
		return Effect.succeed({ type } as FileSystem.File.Info)
	}

	return FileSystem.makeNoop({
		exists: (path) => Effect.succeed(files.has(normalize(path)) || isDirectory(normalize(path))),
		stat: statFor,
		readFileString: (path) => {
			const content = files.get(normalize(path))
			return content === undefined ? Effect.fail(notFound('readFileString', path)) : Effect.succeed(content)
		},
		readDirectory: (path) => {
			const target = normalize(path)
			if (!isDirectory(target)) return Effect.fail(notFound('readDirectory', target))

			const prefix = `${target}/`
			const entries = new Set<string>()
			for (const filePath of files.keys()) {
				if (!filePath.startsWith(prefix)) continue
				const remainder = filePath.slice(prefix.length)
				const first = remainder.split('/')[0]
				if (first !== undefined && first.length > 0) entries.add(first)
			}
			return Effect.succeed([...entries])
		},
		realPath: (path) => Effect.succeed(normalize(path)),
		writeFileString: (path, content) =>
			Effect.sync(() => {
				files.set(normalize(path), content)
			}),
		makeDirectory: () => Effect.void,
		remove: (path) =>
			Effect.sync(() => {
				files.delete(normalize(path))
			}),
	})
}

/** Read one file back out of a memory filesystem fixture (test assertion helper). */
export const memoryFileFor = (fs: FileSystem.FileSystem, path: string): Effect.Effect<string | null> =>
	fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed(null)))

/** Narrow one string-valued field out of an unknown tool result/failure (assertion helper). */
const stringField =
	(field: string) =>
	(value: unknown): string => {
		if (typeof value === 'object' && value !== null && field in value) {
			const candidate: unknown = Reflect.get(value, field)
			if (typeof candidate === 'string') return candidate
		}
		throw new Error(`expected a value with a string "${field}" field`)
	}

/** The `message` field of a tool success/failure value. */
export const messageOf: (value: unknown) => string = stringField('message')

/** The `output` field of a bash tool success value. */
export const outputOf: (value: unknown) => string = stringField('output')

const parentDirs = (path: string): ReadonlyArray<string> => {
	const parents: Array<string> = []
	let current = dirname(path)
	while (current !== dirname(current)) {
		parents.push(current)
		current = dirname(current)
	}
	return parents
}

/** Sanity helper for fixtures: every file path in the map has consistent parents. */
export const assertConsistentFixture = (files: Record<string, string>): void => {
	for (const path of Object.keys(files)) {
		for (const parent of parentDirs(path)) {
			if (files[parent] !== undefined) throw new Error(`fixture path collides with directory: ${parent}`)
		}
	}
}
