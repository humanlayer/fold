/**
 * This file ensures fold's managed binaries (D18): every binary in the registry (`rg`, `fd`,
 * `ast-grep`) resolves system-first, then from `<foldHome>/bin`, then by downloading its pinned
 * GitHub release asset - sha256-verified against the registry pin BEFORE anything touches disk,
 * extracted via the system `tar`/`unzip`, renamed atomically into `<foldHome>/bin/<name>`, and
 * chmod 755. BashTool prepends `~/.fold/bin` to every command's PATH, which is what makes the
 * installed binaries reachable from agent prompts.
 *
 * The ensure NEVER fails: each binary independently degrades to an `unavailable` status with the
 * failure logged as a warning, because a missing binary is a capability downgrade, not a launch
 * failure. `FOLD_DISABLE_BINARY_DOWNLOADS` (read through `Config`) or the `disableDownloads` option
 * (used by `fold bin status`) skip the download step while still reporting system/managed hits.
 *
 * The {@link ManagedBinaries} layer yields everything once when it builds: `FileSystem` (PATH scan,
 * install), `ChildProcessSpawner` (version checks, extraction), `HttpClient` (downloads), the
 * {@link HostPlatform} reference (defaults to the running process), and PATH / PATHEXT / the kill
 * switch through `Config`. Tests swap those layers and provide a `ConfigProvider`. The layer owns a
 * `Cache` keyed by foldHome + download mode, so every caller in one process shares one pass per key.
 *
 * One known tradeoff, inherited from pi: a system ALIAS hit (`fdfind`, `sg`) short-circuits the
 * managed install even though the canonical name stays absent from PATH.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { Cache, Cause, Config, Context, Data, Duration, Effect, FileSystem, Layer, Option, Stream } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { managedBinaryRegistry, type ManagedBinaryAsset, type ManagedBinaryDefinition } from './Registry'

/** Environment variable that, when set (non-empty), disables managed-binary downloads entirely. */
export const FOLD_DISABLE_BINARY_DOWNLOADS = 'FOLD_DISABLE_BINARY_DOWNLOADS'

const downloadTimeoutMillis = 30_000
const execTimeoutMillis = 60_000

/** The directory managed binaries are installed into for a fold home. */
export const managedBinDir = (foldHome: string): string => join(foldHome, 'bin')

/** A release-asset download failed: network error, HTTP error status, or timeout. */
export class BinaryDownloadError extends Data.TaggedError('BinaryDownloadError')<{
	readonly message: string
}> {}

/** A helper command (`tar`, `unzip`, `<binary> --version`) could not run or exited non-zero. */
export class BinaryExecError extends Data.TaggedError('BinaryExecError')<{
	readonly message: string
}> {}

/** A downloaded asset failed verification or did not contain the expected binary. */
export class BinaryInstallError extends Data.TaggedError('BinaryInstallError')<{
	readonly message: string
}> {}

/**
 * How one managed binary resolved: `system` (a usable binary already on PATH), `managed` (already
 * present in `<foldHome>/bin`), `installed-now` (downloaded during this ensure), or `unavailable`.
 */
export type ManagedBinaryResolution = 'system' | 'managed' | 'installed-now' | 'unavailable'

/**
 * The per-binary outcome of one ensure pass. A plain type rather than a schema on purpose: it never
 * crosses a serialization boundary - it is an in-process result the CLI formats directly.
 */
export type ManagedBinaryStatus = {
	readonly name: string
	readonly resolution: ManagedBinaryResolution
	/** Absolute path of the resolved binary, or null when unavailable. */
	readonly path: string | null
	/** Human-readable note: which alias hit, what was downloaded, or why it is unavailable. */
	readonly detail: string | null
}

/** The host platform and architecture assets are selected for (`process.platform` / `process.arch` shapes). */
export type HostPlatformInfo = {
	readonly platform: string
	readonly arch: string
}

/**
 * The running host's platform and architecture. A `Context.Reference` because the value has a
 * natural default (the current process) and only tests override it, with
 * `Layer.succeed(HostPlatform, ...)` under the {@link ManagedBinaries} layer.
 */
export const HostPlatform = Context.Reference<HostPlatformInfo>('fold-agent/Bin/HostPlatform', {
	defaultValue: () => ({ platform: process.platform, arch: process.arch }),
})

/** Options for {@link ensureManagedBinaries}. */
export type EnsureManagedBinariesOptions = {
	/** The fold home directory; binaries install into `<foldHome>/bin`. */
	readonly foldHome: string
	/** Skip the download step (used by `fold bin status`); system/managed hits still resolve. */
	readonly disableDownloads?: boolean
	/** Install/check the canonical managed copy in `<foldHome>/bin` even when a system binary exists. */
	readonly requireManagedInstall?: boolean
	/** Set false to run a fresh pass instead of sharing the per-process cached one. Defaults to true. */
	readonly memoize?: boolean
}

/** What one resolution pass is keyed by: the fold home plus the download mode. */
type EnsureKey = {
	readonly foldHome: string
	readonly disableDownloads: boolean
	readonly requireManagedInstall: boolean
}

/** What the resolver reads once from the host and environment when its layer builds. */
type HostEnvironment = HostPlatformInfo & {
	readonly pathEntries: ReadonlyArray<string>
	readonly executableExtensions: ReadonlyArray<string>
	/** Whether {@link FOLD_DISABLE_BINARY_DOWNLOADS} is set (non-empty). */
	readonly downloadsKillSwitch: boolean
}

/** Everything one resolution pass needs. */
type ResolveContext = EnsureKey & HostEnvironment

/** Parse the first `major.minor.patch` triple out of arbitrary `--version` output; null when absent. */
export const parseBinaryVersion = (text: string): readonly [number, number, number] | null => {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
	if (match === null) return null
	const [, major, minor, patch] = match
	if (major === undefined || minor === undefined || patch === undefined) return null

	return [Number(major), Number(minor), Number(patch)]
}

const versionAtLeast = (left: readonly [number, number, number], right: readonly [number, number, number]): boolean => {
	for (let index = 0; index < 3; index += 1) {
		const a = left[index] ?? 0
		const b = right[index] ?? 0
		if (a !== b) return a > b
	}

	return true
}

/** The installed file name for one definition: `<name>.exe` on Windows, `<name>` elsewhere. */
const installedFileName = (definition: ManagedBinaryDefinition, platform: string): string =>
	platform === 'win32' ? `${definition.name}.exe` : definition.name

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** The file name at the end of a download URL (archives keep their upstream names in the temp dir). */
const assetFileName = (url: string): string => {
	const lastSlash = url.lastIndexOf('/')
	return lastSlash === -1 ? url : url.slice(lastSlash + 1)
}

/** Read one optional environment value through `Config`; absent or empty reads as null. */
const readEnv = (name: string): Effect.Effect<string | null> =>
	Config.option(Config.String(name)).pipe(
		Effect.map((value) =>
			Option.getOrElse(
				Option.filter(value, (text) => text !== ''),
				() => null,
			),
		),
		Effect.catchTag('ConfigError', (error) =>
			Effect.logDebug(`could not read ${name}: ${error.message}`).pipe(Effect.as(null)),
		),
	)

/** Read the host platform, PATH, PATHEXT, and the download kill switch. */
const readHostEnvironment: Effect.Effect<HostEnvironment> = Effect.gen(function* () {
	const host = yield* HostPlatform
	const windows = host.platform === 'win32'
	const pathValue = (yield* readEnv('PATH')) ?? ''
	const pathExt = windows ? ((yield* readEnv('PATHEXT')) ?? '.EXE;.CMD;.BAT;.COM') : null
	const killSwitch = yield* readEnv(FOLD_DISABLE_BINARY_DOWNLOADS)

	return {
		...host,
		downloadsKillSwitch: killSwitch !== null,
		pathEntries: pathValue.split(windows ? ';' : ':').filter((entry) => entry !== ''),
		executableExtensions: pathExt === null ? [''] : pathExt.split(';').map((extension) => extension.toLowerCase()),
	}
})

const makeManagedBinaries = (registry: ReadonlyArray<ManagedBinaryDefinition>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const http = yield* HttpClient.HttpClient
		const environment = yield* readHostEnvironment

		/** Fetch one release asset's bytes, with a 30s timeout. */
		const downloadAsset = (url: string): Effect.Effect<Uint8Array, BinaryDownloadError> =>
			http.get(url).pipe(
				Effect.flatMap(HttpClientResponse.filterStatusOk),
				Effect.flatMap((response) => response.arrayBuffer),
				Effect.map((buffer) => new Uint8Array(buffer)),
				Effect.catchTag('HttpClientError', (error) =>
					Effect.fail(new BinaryDownloadError({ message: `GET ${url}: ${error.message}` })),
				),
				Effect.timeoutOrElse({
					duration: Duration.millis(downloadTimeoutMillis),
					orElse: () =>
						Effect.fail(
							new BinaryDownloadError({
								message: `GET ${url} timed out after ${downloadTimeoutMillis}ms`,
							}),
						),
				}),
			)

		/** Run one helper command to completion; a non-zero exit fails with its stderr. */
		const exec = (command: string, args: ReadonlyArray<string>): Effect.Effect<string, BinaryExecError> => {
			const label = `${command} ${args.join(' ')}`
			return Effect.gen(function* () {
				const handle = yield* spawner.spawn(ChildProcess.make(command, args))
				const [stdout, stderr, exitCode] = yield* Effect.all(
					[
						handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
						handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
						handle.exitCode,
					],
					{ concurrency: 'unbounded' },
				)
				if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
					const trimmed = stderr.trim()
					return yield* new BinaryExecError({
						message: `${label}: exited with code ${exitCode}${trimmed === '' ? '' : ` (${trimmed.slice(0, 400)})`}`,
					})
				}
				return stdout
			}).pipe(
				Effect.scoped,
				Effect.catchTag('PlatformError', (error) =>
					Effect.fail(new BinaryExecError({ message: `${label}: ${error.message}` })),
				),
				Effect.timeoutOrElse({
					duration: Duration.millis(execTimeoutMillis),
					orElse: () =>
						Effect.fail(
							new BinaryExecError({ message: `${label}: timed out after ${execTimeoutMillis}ms` }),
						),
				}),
			)
		}

		/**
		 * Whether one candidate path is an executable regular file. Off Windows, any execute bit
		 * counts (the FileSystem service has no X_OK check); on Windows, PATHEXT already decides.
		 */
		const isExecutableFile = (path: string, platform: string): Effect.Effect<boolean> =>
			fs.stat(path).pipe(
				Effect.map((info) => info.type === 'File' && (platform === 'win32' || (info.mode & 0o111) !== 0)),
				Effect.catchTag('PlatformError', () => Effect.succeed(false)),
			)

		/**
		 * Locate one command on PATH. A manual scan beats shelling out to `command -v`, which also
		 * matches shell builtins and functions.
		 */
		const which = (context: ResolveContext, name: string): Effect.Effect<string | null> =>
			Effect.gen(function* () {
				for (const directory of context.pathEntries) {
					for (const extension of context.executableExtensions) {
						const candidate = join(directory, `${name}${extension}`)
						if (yield* isExecutableFile(candidate, context.platform)) return candidate
					}
				}
				return null
			})

		/**
		 * Whether a resolved system binary satisfies the definition's version floor. Unparseable output
		 * or a failing `--version` counts as NOT satisfying it: falling through to the managed install is
		 * safe (the managed copy shadows nothing - `<foldHome>/bin` is PREPENDED to PATH) and self-healing.
		 */
		const satisfiesMinVersion = (binaryPath: string, minVersion: string): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				const floor = parseBinaryVersion(minVersion)
				if (floor === null) return true

				const output = yield* exec(binaryPath, ['--version']).pipe(Effect.option)
				if (Option.isNone(output)) return false
				const version = parseBinaryVersion(output.value)

				return version !== null && versionAtLeast(version, floor)
			})

		/**
		 * Extract one archive into a directory. tar.gz goes straight to the system `tar`; zip tries
		 * `unzip` first and falls back to `tar xf` (bsdtar on macOS and Windows System32 reads zip
		 * archives; GNU tar does not, hence the unzip-first order).
		 */
		const extractArchive = (
			asset: ManagedBinaryAsset,
			archivePath: string,
			extractDir: string,
		): Effect.Effect<void, BinaryExecError> => {
			if (asset.archive === 'tar.gz') {
				return exec('tar', ['xzf', archivePath, '-C', extractDir]).pipe(Effect.asVoid)
			}

			return exec('unzip', ['-q', '-o', archivePath, '-d', extractDir]).pipe(
				Effect.catchTag('BinaryExecError', (unzipError) =>
					exec('tar', ['xf', archivePath, '-C', extractDir]).pipe(
						Effect.mapError(
							(tarError) =>
								new BinaryExecError({ message: `${unzipError.message}; ${tarError.message}` }),
						),
					),
				),
				Effect.asVoid,
			)
		}

		/**
		 * Download, verify, extract, and install one binary. Verification happens on the in-memory
		 * bytes BEFORE anything is written, so a bad digest never leaves a file behind; the rename out
		 * of a temp directory under `<foldHome>/bin` keeps the final write atomic on one filesystem.
		 */
		const installFromAsset = (
			context: ResolveContext,
			definition: ManagedBinaryDefinition,
			asset: ManagedBinaryAsset,
			installPath: string,
		) =>
			Effect.gen(function* () {
				const bytes = yield* downloadAsset(asset.url)

				if (asset.sha256 !== null) {
					const digest = sha256Hex(bytes)
					if (digest !== asset.sha256) {
						return yield* new BinaryInstallError({
							message: `sha256 mismatch for ${asset.url}: expected ${asset.sha256}, downloaded ${digest}`,
						})
					}
				}

				const binDir = managedBinDir(context.foldHome)
				yield* fs.makeDirectory(binDir, { recursive: true })
				yield* Effect.gen(function* () {
					const extractDir = yield* fs.makeTempDirectoryScoped({
						directory: binDir,
						prefix: `.tmp-${definition.name}-`,
					})
					const archivePath = join(extractDir, assetFileName(asset.url))
					yield* fs.writeFile(archivePath, bytes)
					yield* extractArchive(asset, archivePath, extractDir)

					const extractedPath = join(extractDir, asset.pathInArchive)
					const present = yield* fs.exists(extractedPath).pipe(Effect.orElseSucceed(() => false))
					if (!present) {
						return yield* new BinaryInstallError({
							message: `${assetFileName(asset.url)} did not contain ${asset.pathInArchive}`,
						})
					}

					yield* fs.rename(extractedPath, installPath)
					yield* fs.chmod(installPath, 0o755)
				}).pipe(Effect.scoped)
			})

		/** Resolve one binary through the system -> managed -> download ladder. Failures propagate typed. */
		const resolveOne = (context: ResolveContext, definition: ManagedBinaryDefinition) =>
			Effect.gen(function* () {
				const resolveSystem = Effect.gen(function* () {
					for (const systemName of definition.systemNames) {
						const found = yield* which(context, systemName)
						if (found === null) continue
						if (definition.minVersion !== null) {
							const usable = yield* satisfiesMinVersion(found, definition.minVersion)
							if (!usable) continue
						}

						return {
							name: definition.name,
							resolution: 'system' as const,
							path: found,
							detail: `system binary "${systemName}" on PATH`,
						}
					}

					return null
				})

				if (!context.requireManagedInstall) {
					const system = yield* resolveSystem
					if (system !== null) return system
				}

				const binDir = managedBinDir(context.foldHome)
				const installPath = join(binDir, installedFileName(definition, context.platform))
				const installed = yield* fs.exists(installPath).pipe(Effect.orElseSucceed(() => false))
				if (installed) {
					return {
						name: definition.name,
						resolution: 'managed' as const,
						path: installPath,
						detail: `already installed in ${binDir}`,
					}
				}

				if (context.requireManagedInstall) {
					const system = yield* resolveSystem
					if (system !== null && context.disableDownloads) return system
				}

				if (context.disableDownloads) {
					return {
						name: definition.name,
						resolution: 'unavailable' as const,
						path: null,
						detail: `binary downloads disabled; not found on PATH or in ${binDir}`,
					}
				}

				const asset = definition.assetFor(context.platform, context.arch)
				if (asset === null) {
					return {
						name: definition.name,
						resolution: 'unavailable' as const,
						path: null,
						detail: `no pinned ${definition.name} asset for ${context.platform}-${context.arch}`,
					}
				}

				yield* installFromAsset(context, definition, asset, installPath)

				return {
					name: definition.name,
					resolution: 'installed-now' as const,
					path: installPath,
					detail: `downloaded ${definition.name} ${definition.version} from ${definition.repo}`,
				}
			})

		/**
		 * One binary's resolution, degraded to `unavailable` on ANY failure or defect. This is the
		 * best-effort boundary, so it deliberately catches the whole cause and keeps the message.
		 */
		const resolveOneNeverFailing = (
			context: ResolveContext,
			definition: ManagedBinaryDefinition,
		): Effect.Effect<ManagedBinaryStatus> =>
			resolveOne(context, definition).pipe(
				Effect.catchCause((cause) =>
					// Debug level: this runs in the background under the TUI, where console warnings would
					// corrupt the screen. `fold bin status|install` print each status's detail instead.
					Effect.logDebug(`could not resolve managed binary ${definition.name}`, cause).pipe(
						Effect.as({
							name: definition.name,
							resolution: 'unavailable' as const,
							path: null,
							detail: Cause.prettyErrors(cause)[0]?.message ?? 'unknown failure',
						}),
					),
				),
			)

		/** One full pass over the registry, every binary resolved concurrently. */
		const resolveAll = (key: EnsureKey): Effect.Effect<ReadonlyArray<ManagedBinaryStatus>> =>
			Effect.gen(function* () {
				const context: ResolveContext = {
					...environment,
					...key,
					disableDownloads: key.disableDownloads || environment.downloadsKillSwitch,
				}
				return yield* Effect.forEach(registry, (definition) => resolveOneNeverFailing(context, definition), {
					concurrency: Math.max(registry.length, 1),
				})
			})

		// Keys are (foldHome, mode) pairs: a handful per process.
		const passes = yield* Cache.make<EnsureKey, ReadonlyArray<ManagedBinaryStatus>>({
			capacity: 64,
			lookup: resolveAll,
		})

		const ensure = Effect.fn('ManagedBinaries.ensure')(function* (options: EnsureManagedBinariesOptions) {
			const key: EnsureKey = {
				foldHome: options.foldHome,
				disableDownloads: options.disableDownloads === true,
				requireManagedInstall: options.requireManagedInstall === true,
			}
			const resolved = options.memoize === false ? yield* resolveAll(key) : yield* Cache.get(passes, key)
			return resolved
		})

		return ManagedBinaries.of({ ensure })
	})

/**
 * The per-process managed-binary resolver. `ensure` never fails; see the file header for the
 * resolution ladder.
 */
export class ManagedBinaries extends Context.Service<
	ManagedBinaries,
	{
		readonly ensure: (options: EnsureManagedBinariesOptions) => Effect.Effect<ReadonlyArray<ManagedBinaryStatus>>
	}
>()('fold-agent/Bin/ManagedBinaries') {
	/** A resolver over a given registry (tests pass a small one). */
	static readonly layerWith = (
		registry: ReadonlyArray<ManagedBinaryDefinition>,
	): Layer.Layer<
		ManagedBinaries,
		never,
		FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
	> => Layer.effect(ManagedBinaries, makeManagedBinaries(registry))

	/** The resolver over fold's pinned {@link managedBinaryRegistry}. */
	static readonly layer = ManagedBinaries.layerWith(managedBinaryRegistry)
}

/**
 * Ensure every managed binary is resolvable, returning one status per registry entry (in registry
 * order). NEVER fails - unavailable binaries degrade with a logged warning. Shares one cached pass
 * per (foldHome, download mode) unless `memoize: false`.
 */
export const ensureManagedBinaries = (
	options: EnsureManagedBinariesOptions,
): Effect.Effect<ReadonlyArray<ManagedBinaryStatus>, never, ManagedBinaries> =>
	ManagedBinaries.use((service) => service.ensure(options))
