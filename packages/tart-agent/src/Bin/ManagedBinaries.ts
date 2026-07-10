/**
 * This file ensures tart's managed binaries (D18): every binary in the registry (`rg`, `fd`,
 * `ast-grep`) resolves system-first, then from `<tartHome>/bin`, then by downloading its pinned
 * GitHub release asset - sha256-verified against the registry pin BEFORE anything touches disk,
 * extracted via the system `tar`/`unzip`, renamed atomically into `<tartHome>/bin/<name>`, and
 * chmod 755. BashTool prepends `~/.tart/bin` to every command's PATH, which is what makes the
 * installed binaries reachable from agent prompts.
 *
 * The ensure NEVER fails: each binary independently degrades to an `unavailable` status with the
 * raw failure logged as a warning, because a missing binary is a capability downgrade, not a launch
 * failure. `TART_DISABLE_BINARY_DOWNLOADS` (env seam) or the `disableDownloads` option (used by
 * `tart bin status`) skip the download step while still reporting system/managed hits. Results are
 * memoized per process, keyed by tartHome + download mode, so the CLI's background ensure and any
 * later call share one resolution pass.
 *
 * Seams follow the tart-agent options convention (Catalog/LoadCatalog.ts): `fileSystem`, `env`,
 * `which`, `download`, and `exec` all carry real defaults and swap wholesale in tests. One known
 * tradeoff, inherited from pi: a system ALIAS hit (`fdfind`, `sg`) short-circuits the managed
 * install even though the canonical name stays absent from PATH.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

import { Cause, Effect, Schema, type FileSystem } from 'effect'

import { fileSystemFor, type FsToolOptions } from '../Fs/DefaultFileSystem'
import { managedBinaryRegistry, type ManagedBinaryAsset, type ManagedBinaryDefinition } from './Registry'

/** Environment variable that, when set (non-empty), disables managed-binary downloads entirely. */
export const TART_DISABLE_BINARY_DOWNLOADS = 'TART_DISABLE_BINARY_DOWNLOADS'

const downloadTimeoutMillis = 30_000
const execTimeoutMillis = 60_000

/** The directory managed binaries are installed into for a tart home. */
export const managedBinDir = (tartHome: string): string => join(tartHome, 'bin')

/** A release-asset download failed: network error, HTTP error status, or timeout. */
export class BinaryDownloadError extends Schema.TaggedErrorClass<BinaryDownloadError>()('BinaryDownloadError', {
	message: Schema.String,
}) {}

/** A helper command (`tar`, `unzip`, `<binary> --version`) could not run or exited non-zero. */
export class BinaryExecError extends Schema.TaggedErrorClass<BinaryExecError>()('BinaryExecError', {
	message: Schema.String,
}) {}

/** A downloaded asset failed verification or did not contain the expected binary. */
export class BinaryInstallError extends Schema.TaggedErrorClass<BinaryInstallError>()('BinaryInstallError', {
	message: Schema.String,
}) {}

/**
 * How one managed binary resolved: `system` (a usable binary already on PATH), `managed` (already
 * present in `<tartHome>/bin`), `installed-now` (downloaded during this ensure), or `unavailable`.
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

/** Locate one command on PATH: the absolute executable path, or null when absent. */
export type WhichSeam = (name: string) => Effect.Effect<string | null>

/** Fetch one release asset's bytes. */
export type DownloadSeam = (url: string) => Effect.Effect<Uint8Array, BinaryDownloadError>

/** Run one helper command to completion, failing on non-zero exit. */
export type ExecSeam = (
	command: string,
	args: ReadonlyArray<string>,
) => Effect.Effect<{ stdout: string }, BinaryExecError>

/** Options for {@link ensureManagedBinaries}. */
export type EnsureManagedBinariesOptions = {
	/** The tart home directory; binaries install into `<tartHome>/bin`. */
	readonly tartHome: string
	/** FileSystem override for hermetic tests. Defaults to the Node platform filesystem. */
	readonly fileSystem?: FsToolOptions['fileSystem']
	/** Environment lookup for {@link TART_DISABLE_BINARY_DOWNLOADS} and PATH. Defaults to `process.env`. */
	readonly env?: (name: string) => string | undefined
	/** PATH lookup seam. Defaults to scanning the env seam's PATH for an executable file. */
	readonly which?: WhichSeam
	/** Asset download seam. Defaults to global `fetch` with a 30s timeout. */
	readonly download?: DownloadSeam
	/** Helper-command seam (version checks, extraction). Defaults to `node:child_process` execFile. */
	readonly exec?: ExecSeam
	/** Platform override for asset selection and file naming. Defaults to `process.platform`. */
	readonly platform?: string
	/** Architecture override for asset selection. Defaults to `process.arch`. */
	readonly arch?: string
	/** Skip the download step (used by `tart bin status`); system/managed hits still resolve. */
	readonly disableDownloads?: boolean
	/** Registry override for tests. Defaults to {@link managedBinaryRegistry}. */
	readonly registry?: ReadonlyArray<ManagedBinaryDefinition>
	/** Set false to bypass the per-process memoization (tests). Defaults to true. */
	readonly memoize?: boolean
}

/** Everything a resolution pass needs, with every seam already defaulted. */
type ResolveContext = {
	readonly tartHome: string
	readonly fs: FileSystem.FileSystem
	readonly env: (name: string) => string | undefined
	readonly which: WhichSeam
	readonly download: DownloadSeam
	readonly exec: ExecSeam
	readonly platform: string
	readonly arch: string
	readonly downloadsDisabled: boolean
}

/** The ONE mapper from thrown download failures to the typed download error. */
const downloadErrorFrom = (url: string, cause: unknown): BinaryDownloadError =>
	new BinaryDownloadError({ message: `GET ${url}: ${cause instanceof Error ? cause.message : String(cause)}` })

const defaultDownload: DownloadSeam = (url) =>
	Effect.tryPromise({
		try: async (signal): Promise<Uint8Array> => {
			const response = await fetch(url, { signal })
			if (!response.ok) throw new Error(`responded ${response.status}`)
			return new Uint8Array(await response.arrayBuffer())
		},
		catch: (cause) => downloadErrorFrom(url, cause),
	}).pipe(
		Effect.timeout(downloadTimeoutMillis),
		Effect.catchTag('TimeoutError', () =>
			Effect.fail(new BinaryDownloadError({ message: `GET ${url} timed out after ${downloadTimeoutMillis}ms` })),
		),
	)

/** The ONE mapper from execFile rejections to the typed exec error. */
const execErrorFrom = (command: string, args: ReadonlyArray<string>, cause: unknown): BinaryExecError => {
	const stderr =
		typeof cause === 'object' && cause !== null && 'stderr' in cause && typeof cause.stderr === 'string'
			? cause.stderr.trim()
			: ''
	const reason = cause instanceof Error ? cause.message : String(cause)
	return new BinaryExecError({
		message: `${command} ${args.join(' ')}: ${reason}${stderr === '' ? '' : ` (${stderr.slice(0, 400)})`}`,
	})
}

const execFileAsync = promisify(execFile)

const defaultExec: ExecSeam = (command, args) =>
	Effect.tryPromise({
		try: async (): Promise<{ stdout: string }> => {
			const result = await execFileAsync(command, [...args], {
				timeout: execTimeoutMillis,
				maxBuffer: 4 * 1024 * 1024,
				windowsHide: true,
			})
			return { stdout: result.stdout }
		},
		catch: (cause) => execErrorFrom(command, args, cause),
	})

/** Whether one candidate path is an executable regular file (real-filesystem check, default seam only). */
const isExecutableFile = (path: string): boolean => {
	try {
		accessSync(path, constants.X_OK)
		return statSync(path).isFile()
	} catch {
		return false
	}
}

/**
 * The default which: scan the env seam's PATH for an executable file, honoring PATHEXT on Windows.
 * A manual scan beats shelling out to `command -v`, which also matches shell builtins and functions.
 */
const defaultWhich =
	(env: (name: string) => string | undefined, platform: string): WhichSeam =>
	(name) =>
		Effect.sync(() => {
			const pathValue = env('PATH') ?? ''
			const extensions =
				platform === 'win32'
					? (env('PATHEXT') ?? '.EXE;.CMD;.BAT;.COM').split(';').map((extension) => extension.toLowerCase())
					: ['']

			for (const directory of pathValue.split(delimiter)) {
				if (directory === '') continue
				for (const extension of extensions) {
					const candidate = join(directory, `${name}${extension}`)
					if (isExecutableFile(candidate)) return candidate
				}
			}

			return null
		})

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

/**
 * Whether a resolved system binary satisfies the definition's version floor. Unparseable output or a
 * failing `--version` counts as NOT satisfying it: falling through to the managed install is safe
 * (the managed copy shadows nothing - `<tartHome>/bin` is PREPENDED to PATH) and self-healing.
 */
const satisfiesMinVersion = (context: ResolveContext, binaryPath: string, minVersion: string): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const floor = parseBinaryVersion(minVersion)
		if (floor === null) return true

		const output = yield* context.exec(binaryPath, ['--version']).pipe(Effect.catch(() => Effect.succeed(null)))
		if (output === null) return false
		const version = parseBinaryVersion(output.stdout)

		return version !== null && versionAtLeast(version, floor)
	})

/** The installed file name for one definition: `<name>.exe` on Windows, `<name>` elsewhere. */
const installedFileName = (definition: ManagedBinaryDefinition, platform: string): string =>
	platform === 'win32' ? `${definition.name}.exe` : definition.name

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** The file name at the end of a download URL (archives keep their upstream names in the temp dir). */
const assetFileName = (url: string): string => {
	const lastSlash = url.lastIndexOf('/')
	return lastSlash === -1 ? url : url.slice(lastSlash + 1)
}

/**
 * Extract one archive into a directory through the exec seam. tar.gz goes straight to the system
 * `tar`; zip tries `unzip` first and falls back to `tar xf` (bsdtar on macOS and Windows System32
 * reads zip archives; GNU tar does not, hence the unzip-first order).
 */
const extractArchive = (
	context: ResolveContext,
	asset: ManagedBinaryAsset,
	archivePath: string,
	extractDir: string,
): Effect.Effect<void, BinaryExecError> => {
	if (asset.archive === 'tar.gz') {
		return context.exec('tar', ['xzf', archivePath, '-C', extractDir]).pipe(Effect.asVoid)
	}

	return context.exec('unzip', ['-q', '-o', archivePath, '-d', extractDir]).pipe(
		Effect.catch((unzipError) =>
			context
				.exec('tar', ['xf', archivePath, '-C', extractDir])
				.pipe(
					Effect.mapError(
						(tarError) => new BinaryExecError({ message: `${unzipError.message}; ${tarError.message}` }),
					),
				),
		),
		Effect.asVoid,
	)
}

/**
 * Download, verify, extract, and install one binary. Verification happens on the in-memory bytes
 * BEFORE anything is written, so a bad digest never leaves a file behind; the rename out of a temp
 * directory under `<tartHome>/bin` keeps the final write atomic on one filesystem.
 */
// Return type inferred: the typed union is the three Binary* errors plus the FileSystem operations'
// platform errors, and the only consumer (resolveOneNeverFailing) catches the whole cause anyway.
const installFromAsset = (
	context: ResolveContext,
	definition: ManagedBinaryDefinition,
	asset: ManagedBinaryAsset,
	installPath: string,
) =>
	Effect.gen(function* () {
		const bytes = yield* context.download(asset.url)

		if (asset.sha256 !== null) {
			const digest = sha256Hex(bytes)
			if (digest !== asset.sha256) {
				return yield* new BinaryInstallError({
					message: `sha256 mismatch for ${asset.url}: expected ${asset.sha256}, downloaded ${digest}`,
				})
			}
		}

		const binDir = managedBinDir(context.tartHome)
		const extractDir = join(binDir, `.tmp-${definition.name}-${randomBytes(6).toString('hex')}`)

		yield* Effect.gen(function* () {
			yield* context.fs.makeDirectory(extractDir, { recursive: true })
			const archivePath = join(extractDir, assetFileName(asset.url))
			yield* context.fs.writeFile(archivePath, bytes)
			yield* extractArchive(context, asset, archivePath, extractDir)

			const extractedPath = join(extractDir, asset.pathInArchive)
			const present = yield* context.fs.exists(extractedPath).pipe(Effect.catch(() => Effect.succeed(false)))
			if (!present) {
				return yield* new BinaryInstallError({
					message: `${assetFileName(asset.url)} did not contain ${asset.pathInArchive}`,
				})
			}

			yield* context.fs.rename(extractedPath, installPath)
			yield* context.fs.chmod(installPath, 0o755)
		}).pipe(
			Effect.ensuring(
				context.fs.remove(extractDir, { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void)),
			),
		)
	})

/** Resolve one binary through the system -> managed -> download ladder. Failures propagate typed (inferred). */
const resolveOne = (context: ResolveContext, definition: ManagedBinaryDefinition) =>
	Effect.gen(function* () {
		for (const systemName of definition.systemNames) {
			const found = yield* context.which(systemName)
			if (found === null) continue
			if (definition.minVersion !== null) {
				const usable = yield* satisfiesMinVersion(context, found, definition.minVersion)
				if (!usable) continue
			}

			return {
				name: definition.name,
				resolution: 'system' as const,
				path: found,
				detail: `system binary "${systemName}" on PATH`,
			}
		}

		const binDir = managedBinDir(context.tartHome)
		const installPath = join(binDir, installedFileName(definition, context.platform))
		const installed = yield* context.fs.exists(installPath).pipe(Effect.catch(() => Effect.succeed(false)))
		if (installed) {
			return {
				name: definition.name,
				resolution: 'managed' as const,
				path: installPath,
				detail: `already installed in ${binDir}`,
			}
		}

		if (context.downloadsDisabled) {
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

/** Human-readable message for one squashed cause value (typed errors carry `message`; guard, never cast). */
const failureMessageOf = (value: unknown): string =>
	typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string'
		? value.message
		: String(value)

/** One binary's resolution, degraded to `unavailable` on ANY failure or defect (capture, then keep going). */
const resolveOneNeverFailing = (
	context: ResolveContext,
	definition: ManagedBinaryDefinition,
): Effect.Effect<ManagedBinaryStatus> =>
	resolveOne(context, definition).pipe(
		Effect.catchCause((cause) => {
			const message = failureMessageOf(Cause.squash(cause))

			return Effect.logWarning(`could not resolve managed binary ${definition.name}: ${message}`).pipe(
				Effect.as({
					name: definition.name,
					resolution: 'unavailable' as const,
					path: null,
					detail: message,
				}),
			)
		}),
	)

const ensureOnce = (options: EnsureManagedBinariesOptions): Effect.Effect<ReadonlyArray<ManagedBinaryStatus>> =>
	Effect.gen(function* () {
		const env = options.env ?? ((name: string) => process.env[name])
		const platform = options.platform ?? process.platform
		const disableFlag = env(TART_DISABLE_BINARY_DOWNLOADS)
		const context: ResolveContext = {
			tartHome: options.tartHome,
			fs: fileSystemFor(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
			env,
			which: options.which ?? defaultWhich(env, platform),
			download: options.download ?? defaultDownload,
			exec: options.exec ?? defaultExec,
			platform,
			arch: options.arch ?? process.arch,
			downloadsDisabled: options.disableDownloads === true || (disableFlag !== undefined && disableFlag !== ''),
		}
		const registry = options.registry ?? managedBinaryRegistry

		return yield* Effect.forEach(registry, (definition) => resolveOneNeverFailing(context, definition), {
			concurrency: registry.length === 0 ? 1 : registry.length,
		})
	})

const memoizedRuns = new Map<string, Effect.Effect<ReadonlyArray<ManagedBinaryStatus>>>()

/**
 * Ensure every managed binary is resolvable, returning one status per registry entry (in registry
 * order). NEVER fails - unavailable binaries degrade with a logged warning. Memoized per process
 * and (tartHome, download mode), so the second call is free.
 */
export const ensureManagedBinaries = (
	options: EnsureManagedBinariesOptions,
): Effect.Effect<ReadonlyArray<ManagedBinaryStatus>> =>
	Effect.suspend(() => {
		if (options.memoize === false) return ensureOnce(options)

		const key = `${options.tartHome} ${options.disableDownloads === true}`
		const existing = memoizedRuns.get(key)
		if (existing !== undefined) return existing

		// Effect.cached construction is synchronous; the Map get/set pair runs without a yield point in
		// between, so concurrent callers cannot race past each other into two resolution passes.
		const run = Effect.runSync(Effect.cached(ensureOnce(options)))
		memoizedRuns.set(key, run)

		return run
	})
