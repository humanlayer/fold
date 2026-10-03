/**
 * Managed-binaries tests (D18): the system -> managed -> download resolution ladder, alias and
 * version-floor handling on system hits, sha256 verification before anything touches disk, the
 * download kill switch, never-failing degradation, and per-process caching. The resolver runs on
 * the real filesystem in a temp dir (PATH scan, extract/rename/chmod); the child-process spawner and
 * HttpClient are fake layers that record what they were asked to do, and env comes from a
 * `ConfigProvider`.
 */
import { dirname, join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, FileSystem, Layer, Sink, Stream } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import {
	ensureManagedBinaries,
	FOLD_DISABLE_BINARY_DOWNLOADS,
	HostPlatform,
	ManagedBinaries,
	managedBinDir,
	parseBinaryVersion,
	type ManagedBinaryDefinition,
} from '../../src/index'
import { offlineHttpClient, tempDir } from '../TestHelpers'

const binaryBytes = new TextEncoder().encode('#!/bin/sh\necho fake binary\n')

const definitionOf = (overrides?: Partial<ManagedBinaryDefinition>): ManagedBinaryDefinition => ({
	name: 'rg',
	repo: 'example/rg',
	version: '1.0.0',
	systemNames: ['rg'],
	minVersion: null,
	assetFor: () => ({
		url: 'https://example.com/rg-1.0.0.tar.gz',
		archive: 'tar.gz',
		pathInArchive: 'rg-1.0.0/rg',
		sha256: null,
	}),
	...overrides,
})

/** HttpClient returning fixed bytes, recording every requested URL. */
const recordingDownload = (
	bytes: Uint8Array<ArrayBuffer>,
): { readonly layer: Layer.Layer<HttpClient.HttpClient>; readonly urls: Array<string> } => {
	const urls: Array<string> = []
	return {
		urls,
		layer: Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request) =>
				Effect.sync(() => {
					urls.push(request.url)
					return HttpClientResponse.fromWeb(request, new Response(bytes))
				}),
			),
		),
	}
}

/** What one fake process run produces. */
type FakeRun = {
	readonly stdout?: string
	readonly stderr?: string
	readonly exitCode?: number
}

type FakeCommand = (
	command: string,
	args: ReadonlyArray<string>,
) => Effect.Effect<FakeRun, never, FileSystem.FileSystem>

const textStream = (text: string) => Stream.make(new TextEncoder().encode(text))

/** A spawner whose processes run `respond` instead of a real program; records every command line. */
const fakeSpawner = (
	respond: FakeCommand,
): {
	readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, never, FileSystem.FileSystem>
	readonly commands: Array<string>
} => {
	const commands: Array<string> = []
	return {
		commands,
		layer: Layer.effect(
			ChildProcessSpawner.ChildProcessSpawner,
			Effect.gen(function* () {
				const context = yield* Effect.context<FileSystem.FileSystem>()
				return ChildProcessSpawner.make((command) => {
					if (!ChildProcess.isStandardCommand(command))
						return Effect.die(new Error('unexpected piped command'))
					commands.push([command.command, ...command.args].join(' '))
					return respond(command.command, command.args).pipe(
						Effect.provideContext(context),
						Effect.map((run) =>
							ChildProcessSpawner.makeHandle({
								pid: ChildProcessSpawner.ProcessId(1),
								exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(run.exitCode ?? 0)),
								isRunning: Effect.succeed(false),
								kill: () => Effect.void,
								stdin: Sink.drain,
								stdout: textStream(run.stdout ?? ''),
								stderr: textStream(run.stderr ?? ''),
								all: textStream(`${run.stdout ?? ''}${run.stderr ?? ''}`),
								getInputFd: () => Sink.drain,
								getOutputFd: () => Stream.empty,
								unref: Effect.succeed(Effect.void),
							}),
						),
					)
				})
			}),
		),
	}
}

/**
 * Emulates `tar xzf <archive> -C <dir>` (and `unzip -d <dir>`) by writing the expected binary into
 * the extraction dir, and answers `--version` probes with the given output.
 */
const extracting =
	(pathInArchive: string, versionOutput = ''): FakeCommand =>
	(_command, args) =>
		Effect.gen(function* () {
			if (args.includes('--version')) return { stdout: versionOutput }
			const flagIndex = Math.max(args.indexOf('-C'), args.indexOf('-d'))
			const extractDir = args[flagIndex + 1]
			if (flagIndex === -1 || extractDir === undefined) return { exitCode: 2, stderr: 'no target dir' }
			const fs = yield* FileSystem.FileSystem
			const target = join(extractDir, pathInArchive)
			yield* fs.makeDirectory(dirname(target), { recursive: true }).pipe(Effect.orDie)
			yield* fs.writeFile(target, binaryBytes).pipe(Effect.orDie)
			return {}
		})

/** A spawner that must never run: any command is a test failure. */
const noCommands: FakeCommand = (command, args) =>
	Effect.die(new Error(`unexpected command ${command} ${args.join(' ')}`))

/** The resolver over a test registry, with every external seam replaced. */
const resolverLayer = (input: {
	readonly registry: ReadonlyArray<ManagedBinaryDefinition>
	readonly env: Record<string, string>
	readonly spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, never, FileSystem.FileSystem>
	readonly http: Layer.Layer<HttpClient.HttpClient>
}): Layer.Layer<ManagedBinaries> =>
	ManagedBinaries.layerWith(input.registry).pipe(
		Layer.provide(
			Layer.mergeAll(
				input.spawner,
				input.http,
				ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env })),
				Layer.succeed(HostPlatform, { platform: 'linux', arch: 'x64' }),
			).pipe(Layer.provideMerge(NodeFileSystem.layer)),
		),
	)

/** Put one fake executable (or, with a non-exec mode, a plain file) into a PATH dir. */
const onPath = (directory: string, name: string, mode = 0o755): Effect.Effect<string, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = join(directory, name)
		yield* fs.makeDirectory(directory, { recursive: true })
		yield* fs.writeFile(path, binaryBytes)
		yield* fs.chmod(path, mode)
		return path
	}).pipe(Effect.orDie)

const exists = (path: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
	FileSystem.FileSystem.use((fs) => fs.exists(path)).pipe(Effect.orDie)

it.effect('a system alias hit short-circuits the ladder without downloading', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const pathDir = join(home, 'sys')
		const fdfind = yield* onPath(pathDir, 'fdfind')
		const download = recordingDownload(binaryBytes)
		const spawner = fakeSpawner(noCommands)

		const [status] = yield* ensureManagedBinaries({ foldHome: home }).pipe(
			Effect.provide(
				resolverLayer({
					registry: [definitionOf({ name: 'fd', systemNames: ['fd', 'fdfind'] })],
					env: { PATH: pathDir },
					spawner: spawner.layer,
					http: download.layer,
				}),
			),
		)

		expect(status?.resolution).toBe('system')
		expect(status?.path).toBe(fdfind)
		expect(status?.detail).toContain('fdfind')
		expect(download.urls).toEqual([])
		expect(spawner.commands).toEqual([])
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('a non-executable file on PATH is not a system hit', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const pathDir = join(home, 'sys')
		yield* onPath(pathDir, 'rg', 0o644)

		const [status] = yield* ensureManagedBinaries({ foldHome: home, disableDownloads: true }).pipe(
			Effect.provide(
				resolverLayer({
					registry: [definitionOf()],
					env: { PATH: pathDir },
					spawner: fakeSpawner(noCommands).layer,
					http: recordingDownload(binaryBytes).layer,
				}),
			),
		)

		expect(status?.resolution).toBe('unavailable')
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('requireManagedInstall installs the canonical managed binary even when a system binary exists', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const pathDir = join(home, 'sys')
		yield* onPath(pathDir, 'rg')
		const download = recordingDownload(binaryBytes)

		const [status] = yield* ensureManagedBinaries({ foldHome: home, requireManagedInstall: true }).pipe(
			Effect.provide(
				resolverLayer({
					registry: [definitionOf()],
					env: { PATH: pathDir },
					spawner: fakeSpawner(extracting('rg-1.0.0/rg')).layer,
					http: download.layer,
				}),
			),
		)

		expect(status?.resolution).toBe('installed-now')
		expect(status?.path).toBe(join(managedBinDir(home), 'rg'))
		expect(yield* exists(join(managedBinDir(home), 'rg'))).toBe(true)
		expect(download.urls).toEqual(['https://example.com/rg-1.0.0.tar.gz'])
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('requireManagedInstall plus disabled downloads can still report a usable system binary', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const pathDir = join(home, 'sys')
		const rg = yield* onPath(pathDir, 'rg')

		const [status] = yield* ensureManagedBinaries({
			foldHome: home,
			disableDownloads: true,
			requireManagedInstall: true,
		}).pipe(
			Effect.provide(
				resolverLayer({
					registry: [definitionOf()],
					env: { PATH: pathDir },
					spawner: fakeSpawner(noCommands).layer,
					http: recordingDownload(binaryBytes).layer,
				}),
			),
		)

		expect(status?.resolution).toBe('system')
		expect(status?.path).toBe(rg)
		expect(yield* exists(join(managedBinDir(home), 'rg'))).toBe(false)
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('a system binary below the version floor falls through past the system rung', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const pathDir = join(home, 'sys')
		const astGrep = yield* onPath(pathDir, 'ast-grep')
		const spawner = fakeSpawner(extracting('unused', 'ast-grep 0.39.6'))

		const [status] = yield* ensureManagedBinaries({ foldHome: home, disableDownloads: true }).pipe(
			Effect.provide(
				resolverLayer({
					registry: [definitionOf({ name: 'ast-grep', systemNames: ['ast-grep'], minVersion: '0.44.0' })],
					env: { PATH: pathDir },
					spawner: spawner.layer,
					http: recordingDownload(binaryBytes).layer,
				}),
			),
		)

		// Not 'system': the old binary was rejected; with downloads disabled the ladder ends unavailable.
		expect(status?.resolution).toBe('unavailable')
		expect(status?.detail).toContain('downloads disabled')
		expect(spawner.commands).toEqual([`${astGrep} --version`])
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('an already-installed managed binary resolves without downloading', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		yield* onPath(managedBinDir(home), 'rg')
		const download = recordingDownload(binaryBytes)

		const [status] = yield* ensureManagedBinaries({ foldHome: home }).pipe(
			Effect.provide(
				resolverLayer({
					registry: [definitionOf()],
					env: {},
					spawner: fakeSpawner(noCommands).layer,
					http: download.layer,
				}),
			),
		)

		expect(status?.resolution).toBe('managed')
		expect(status?.path).toBe(join(managedBinDir(home), 'rg'))
		expect(download.urls).toEqual([])
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('a missing binary downloads, extracts, and installs into <foldHome>/bin', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const download = recordingDownload(binaryBytes)
		const spawner = fakeSpawner(extracting('rg-1.0.0/rg'))

		const [status] = yield* ensureManagedBinaries({ foldHome: home }).pipe(
			Effect.provide(
				resolverLayer({ registry: [definitionOf()], env: {}, spawner: spawner.layer, http: download.layer }),
			),
		)

		const fs = yield* FileSystem.FileSystem
		const installed = join(managedBinDir(home), 'rg')
		expect(status?.resolution).toBe('installed-now')
		expect(status?.path).toBe(installed)
		expect(((yield* fs.stat(installed)).mode & 0o777).toString(8)).toBe('755')
		// The temp extraction dir is gone; only the installed binary remains.
		expect(yield* fs.readDirectory(managedBinDir(home))).toEqual(['rg'])
		expect(download.urls).toEqual(['https://example.com/rg-1.0.0.tar.gz'])
		expect(spawner.commands).toHaveLength(1)
		expect(spawner.commands[0]).toMatch(/^tar xzf .*rg-1\.0\.0\.tar\.gz -C /)
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('a zip asset falls back to tar when unzip fails', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const spawner = fakeSpawner((command, args) =>
			command === 'unzip'
				? Effect.succeed({ exitCode: 127, stderr: 'unzip: not found' })
				: extracting('sg')(command, args),
		)

		const [status] = yield* ensureManagedBinaries({ foldHome: home }).pipe(
			Effect.provide(
				resolverLayer({
					registry: [
						definitionOf({
							name: 'ast-grep',
							assetFor: () => ({
								url: 'https://example.com/ast-grep.zip',
								archive: 'zip',
								pathInArchive: 'sg',
								sha256: null,
							}),
						}),
					],
					env: {},
					spawner: spawner.layer,
					http: recordingDownload(binaryBytes).layer,
				}),
			),
		)

		expect(status?.resolution).toBe('installed-now')
		expect(spawner.commands.map((line) => line.split(' ')[0])).toEqual(['unzip', 'tar'])
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('a sha256 mismatch degrades to unavailable and writes nothing', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const spawner = fakeSpawner(extracting('rg-1.0.0/rg'))

		const [status] = yield* ensureManagedBinaries({ foldHome: home }).pipe(
			Effect.provide(
				resolverLayer({
					registry: [
						definitionOf({
							assetFor: () => ({
								url: 'https://example.com/rg-1.0.0.tar.gz',
								archive: 'tar.gz',
								pathInArchive: 'rg-1.0.0/rg',
								sha256: 'deadbeef',
							}),
						}),
					],
					env: {},
					spawner: spawner.layer,
					http: recordingDownload(binaryBytes).layer,
				}),
			),
		)

		expect(status?.resolution).toBe('unavailable')
		expect(status?.detail).toContain('sha256 mismatch')
		// Verification runs on the in-memory bytes: not even the bin dir was created.
		expect(yield* exists(managedBinDir(home))).toBe(false)
		expect(spawner.commands).toEqual([])
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('the env kill switch skips downloads entirely', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const download = recordingDownload(binaryBytes)

		const [status] = yield* ensureManagedBinaries({ foldHome: home }).pipe(
			Effect.provide(
				resolverLayer({
					registry: [definitionOf()],
					env: { [FOLD_DISABLE_BINARY_DOWNLOADS]: '1' },
					spawner: fakeSpawner(noCommands).layer,
					http: download.layer,
				}),
			),
		)

		expect(status?.resolution).toBe('unavailable')
		expect(status?.detail).toContain('downloads disabled')
		expect(download.urls).toEqual([])
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('one failing binary never blocks the rest (ensure never fails)', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const pathDir = join(home, 'sys')
		yield* onPath(pathDir, 'fd')

		const statuses = yield* ensureManagedBinaries({ foldHome: home }).pipe(
			Effect.provide(
				resolverLayer({
					registry: [definitionOf(), definitionOf({ name: 'fd', systemNames: ['fd'] })],
					env: { PATH: pathDir },
					spawner: fakeSpawner(noCommands).layer,
					http: offlineHttpClient,
				}),
			),
		)

		expect(statuses.map((status) => status.resolution)).toEqual(['unavailable', 'system'])
		expect(statuses[0]?.detail).toContain('network down')
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('a failing extraction also degrades to unavailable and cleans up', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const spawner = fakeSpawner(() => Effect.succeed({ exitCode: 1, stderr: 'exploded' }))

		const [status] = yield* ensureManagedBinaries({ foldHome: home }).pipe(
			Effect.provide(
				resolverLayer({
					registry: [definitionOf()],
					env: {},
					spawner: spawner.layer,
					http: recordingDownload(binaryBytes).layer,
				}),
			),
		)

		expect(status?.resolution).toBe('unavailable')
		expect(status?.detail).toContain('exploded')
		expect(yield* FileSystem.FileSystem.use((fs) => fs.readDirectory(managedBinDir(home)))).toEqual([])
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('cached ensures share one resolution pass per (foldHome, mode); memoize false runs fresh', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const download = recordingDownload(binaryBytes)

		const [first, second, fresh] = yield* Effect.all([
			ensureManagedBinaries({ foldHome: home }),
			ensureManagedBinaries({ foldHome: home, requireManagedInstall: false }),
			ensureManagedBinaries({ foldHome: home, memoize: false }),
		]).pipe(
			Effect.provide(
				resolverLayer({
					registry: [definitionOf()],
					env: {},
					spawner: fakeSpawner(extracting('rg-1.0.0/rg')).layer,
					http: download.layer,
				}),
			),
		)

		expect(first?.[0]?.resolution).toBe('installed-now')
		expect(second?.[0]?.resolution).toBe('installed-now')
		// One download despite two cached calls; the fresh pass finds the managed copy.
		expect(fresh?.[0]?.resolution).toBe('managed')
		expect(download.urls).toEqual(['https://example.com/rg-1.0.0.tar.gz'])
	}).pipe(Effect.provide(NodeFileSystem.layer)),
)

it('parseBinaryVersion pulls the first semver triple out of arbitrary --version output', () => {
	expect(parseBinaryVersion('ripgrep 15.1.0 (rev abc)')).toEqual([15, 1, 0])
	expect(parseBinaryVersion('ast-grep 0.44.1')).toEqual([0, 44, 1])
	expect(parseBinaryVersion('no digits here')).toBeNull()
})
