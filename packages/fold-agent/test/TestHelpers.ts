/**
 * Shared fixtures for fold-agent tool tests: ambient tool services (recorded ToolEvents, no-op
 * ToolState/StopController, the platform, photon, and an output store in a scoped temp directory), scoped temp
 * directories on the real filesystem, and an in-memory
 * FileSystem built on `FileSystem.makeNoop` for tests that must not touch the user's disk (skill scan
 * paths reach the home directory).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
	AgentId,
	CurrentAgent,
	CurrentToolCall,
	InterruptNote,
	StopController,
	ToolCallId,
	ToolEvents,
	ToolResultFailure,
	ToolResultSuccess,
	ToolState,
	type FoldTool,
} from '@humanlayer/fold-core'
import { Effect, FileSystem, Layer, type Path, PlatformError, Ref, Schema, type Scope } from 'effect'
import { HttpClient, HttpClientError } from 'effect/http'
import type { ChildProcessSpawner } from 'effect/process'

import { layerOutputStore, type OutputStore } from '../src/OutputStore/OutputStore'
import { Photon } from '../src/Tools/Image/Photon'

/** A scoped temp directory on the real filesystem, removed when the scope closes. */
export const tempDir = Effect.acquireRelease(
	Effect.sync(() => mkdtempSync(join(tmpdir(), 'fold-agent-test-'))),
	(directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
)

/** Run a tool handler effect with stubbed ambient services and recorded ToolEvents/InterruptNote feeds. */
export const makeAmbientServices: Effect.Effect<
	{
		/** The per-call services, the platform, an output store, and the real photon image library. */
		readonly layer: Layer.Layer<
			| ToolState
			| ToolEvents
			| StopController
			| CurrentAgent
			| CurrentToolCall
			| InterruptNote
			| FileSystem.FileSystem
			| Path.Path
			| ChildProcessSpawner.ChildProcessSpawner
			| OutputStore
			| Photon
		>
		readonly emitted: Effect.Effect<ReadonlyArray<Schema.Json>>
		/** The most recent InterruptNote the handler recorded, or null. */
		readonly interruptNote: Effect.Effect<string | null>
		/** Where the output store writes, removed when the scope closes. */
		readonly outputDirectory: string
	},
	never,
	Scope.Scope
> = Effect.gen(function* () {
	const events = yield* Ref.make<ReadonlyArray<Schema.Json>>([])
	const note = yield* Ref.make<string | null>(null)
	const outputDirectory = yield* tempDir

	return {
		layer: Layer.mergeAll(
			NodeServices.layer,
			Layer.succeed(ToolState, { get: () => Effect.succeed(null), set: () => Effect.void }),
			Layer.succeed(ToolEvents, {
				emit: (payload) => Ref.update(events, (recorded) => [...recorded, payload]),
			}),
			Layer.succeed(StopController, {
				requestStop: () => Effect.void,
				isStopRequested: Effect.succeed(false),
			}),
			Layer.succeed(CurrentAgent, {
				agentId: AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa'),
				parentAgentId: null,
			}),
			Layer.succeed(CurrentToolCall, {
				toolCallId: ToolCallId.make('tool_call_aaaaaaaaaaaaaaaaaaaaaaaa'),
			}),
			Layer.succeed(InterruptNote, { set: (text) => Ref.set(note, text) }),
			layerOutputStore({ directory: outputDirectory }).pipe(Layer.provide(NodeFileSystem.layer)),
			Photon.layer,
		),
		emitted: Ref.get(events),
		interruptNote: Ref.get(note),
		outputDirectory,
	}
})

/** One realized tool call: it needs the per-call services plus the tool's own host services `R`. */
type ToolCall<R> = Effect.Effect<
	ToolResultSuccess,
	ToolResultFailure,
	ToolState | ToolEvents | StopController | CurrentAgent | CurrentToolCall | InterruptNote | R
>

/**
 * Initialize a tool the way the session does and return its handler. A realized handler's success and
 * failure are erased; every built-in tool succeeds with `ToolResultSuccess` and fails with
 * `ToolResultFailure`, so both are decoded back at this test boundary. Anything else is a defect.
 */
export const realizeTool = <R>(
	tool: FoldTool<R>,
): Effect.Effect<(params: unknown) => ToolCall<R>, never, R | Scope.Scope> =>
	Effect.map(
		tool.init,
		(contribution) =>
			(params): ToolCall<R> =>
				// oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- the erased handler is decoded here
				contribution.handler(params).pipe(
					Effect.catch((error) =>
						Schema.decodeUnknownEffect(ToolResultFailure)(error).pipe(
							Effect.orDie,
							Effect.flatMap(Effect.fail),
						),
					),
					Effect.flatMap((result) =>
						Schema.decodeUnknownEffect(ToolResultSuccess)(result).pipe(Effect.orDie),
					),
				),
	)

/** Call a tool through its init, the way the runtime does. */
export const callTool = <R>(
	tool: FoldTool<R>,
	params: unknown,
): Effect.Effect<
	ToolResultSuccess,
	ToolResultFailure,
	ToolState | ToolEvents | StopController | CurrentAgent | CurrentToolCall | InterruptNote | R | Scope.Scope
> => Effect.flatMap(realizeTool(tool), (handler) => handler(params))

export const handlerOf =
	<R>(tool: FoldTool<R>) =>
	(
		params: unknown,
	): Effect.Effect<
		ToolResultSuccess,
		ToolResultFailure,
		ToolState | ToolEvents | StopController | CurrentAgent | CurrentToolCall | InterruptNote | R | Scope.Scope
	> =>
		callTool(tool, params)

/** Run one handler with throwaway ambient services; anything else it needs, the caller provides. */
export const runHandler = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<
	A,
	E,
	Exclude<
		Exclude<
			R,
			| ToolState
			| ToolEvents
			| StopController
			| CurrentAgent
			| CurrentToolCall
			| InterruptNote
			| FileSystem.FileSystem
			| Path.Path
			| ChildProcessSpawner.ChildProcessSpawner
			| OutputStore
			| Photon
		>,
		Scope.Scope
	>
> =>
	Effect.gen(function* () {
		const ambient = yield* makeAmbientServices
		return yield* effect.pipe(Effect.provide(ambient.layer))
	}).pipe(Effect.scoped)

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
		writeFileString: (path, content, options) =>
			Effect.sync(() => {
				const target = normalize(path)
				files.set(target, options?.flag === 'a' ? `${files.get(target) ?? ''}${content}` : content)
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
	fs.readFileString(path).pipe(Effect.orElseSucceed(() => null))

/** An HttpClient with no network: every request fails at the transport with "network down". */
export const offlineHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
	HttpClient.HttpClient,
	HttpClient.make((request) =>
		Effect.fail(
			new HttpClientError.HttpClientError({
				reason: new HttpClientError.TransportError({ request, description: 'network down' }),
			}),
		),
	),
)

const TextResult = Schema.Struct({ text: Schema.String })
const decodeTextResult = Schema.decodeUnknownSync(TextResult)

/** The `text` field of a tool success/failure value. */
export const messageOf = (value: unknown): string => decodeTextResult(value).text

/** The `text` field of a bash tool success value. */
export const outputOf = (value: unknown): string => decodeTextResult(value).text

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
