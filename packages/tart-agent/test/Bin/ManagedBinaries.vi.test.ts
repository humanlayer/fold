/**
 * Managed-binaries tests (D18): the system -> managed -> download resolution ladder, alias and
 * version-floor handling on system hits, sha256 verification before anything touches disk, the
 * download kill switch, never-failing degradation, and per-process memoization. Every seam is
 * injected (which/download/exec/env); installs land on a real temp dir so the extract/rename/chmod
 * path is exercised against the actual filesystem.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import {
	BinaryDownloadError,
	BinaryExecError,
	ensureManagedBinaries,
	managedBinDir,
	parseBinaryVersion,
	TART_DISABLE_BINARY_DOWNLOADS,
	type DownloadSeam,
	type ExecSeam,
	type ManagedBinaryDefinition,
	type WhichSeam,
} from '../../src/index'
import { tempDir } from '../TestHelpers'

const binaryBytes = new TextEncoder().encode('#!/bin/sh\necho fake binary\n')

// sha256 of `binaryBytes`, precomputed so the verification test has a real matching digest.
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

const whichOf =
	(hits: Readonly<Record<string, string>>): WhichSeam =>
	(name) =>
		Effect.succeed(hits[name] ?? null)

/** Download seam returning fixed bytes, recording every requested URL. */
const recordingDownload = (bytes: Uint8Array): { readonly seam: DownloadSeam; readonly urls: Array<string> } => {
	const urls: Array<string> = []
	return {
		urls,
		seam: (url) =>
			Effect.sync(() => {
				urls.push(url)
				return bytes
			}),
	}
}

/**
 * Exec seam that emulates `tar xzf <archive> -C <dir>` by writing the expected binary into the
 * extraction dir, and answers `--version` probes with the given output.
 */
const extractingExec =
	(pathInArchive: string, versionOutput = ''): ExecSeam =>
	(command, args) =>
		Effect.sync(() => {
			if (args[0] === '--version' || args.includes('--version')) return { stdout: versionOutput }
			const extractDir = args[args.indexOf('-C') + 1]
			if (command === 'tar' && extractDir !== undefined) {
				const target = join(extractDir, pathInArchive)
				mkdirSync(dirname(target), { recursive: true })
				writeFileSync(target, binaryBytes)
				return { stdout: '' }
			}
			return { stdout: '' }
		})

const emptyEnv = (): string | undefined => undefined

it.effect('a system alias hit short-circuits the ladder without downloading', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const download = recordingDownload(binaryBytes)
		const [status] = yield* ensureManagedBinaries({
			tartHome: home,
			memoize: false,
			env: emptyEnv,
			which: whichOf({ fdfind: '/usr/bin/fdfind' }),
			download: download.seam,
			registry: [definitionOf({ name: 'fd', systemNames: ['fd', 'fdfind'] })],
		})

		expect(status?.resolution).toBe('system')
		expect(status?.path).toBe('/usr/bin/fdfind')
		expect(status?.detail).toContain('fdfind')
		expect(download.urls).toEqual([])
	}),
)

it.effect('requireManagedInstall installs the canonical managed binary even when a system binary exists', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const download = recordingDownload(binaryBytes)

		const [status] = yield* ensureManagedBinaries({
			tartHome: home,
			memoize: false,
			env: emptyEnv,
			which: whichOf({ rg: '/opt/homebrew/bin/rg' }),
			download: download.seam,
			exec: extractingExec('rg-1.0.0/rg'),
			requireManagedInstall: true,
			registry: [definitionOf()],
		})

		expect(status?.resolution).toBe('installed-now')
		expect(status?.path).toBe(join(managedBinDir(home), 'rg'))
		expect(existsSync(join(managedBinDir(home), 'rg'))).toBe(true)
		expect(download.urls).toEqual(['https://example.com/rg-1.0.0.tar.gz'])
	}),
)

it.effect('requireManagedInstall plus disabled downloads can still report a usable system binary', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const [status] = yield* ensureManagedBinaries({
			tartHome: home,
			memoize: false,
			disableDownloads: true,
			env: emptyEnv,
			which: whichOf({ rg: '/opt/homebrew/bin/rg' }),
			requireManagedInstall: true,
			registry: [definitionOf()],
		})

		expect(status?.resolution).toBe('system')
		expect(status?.path).toBe('/opt/homebrew/bin/rg')
		expect(existsSync(join(managedBinDir(home), 'rg'))).toBe(false)
	}),
)

it.effect('a system binary below the version floor falls through past the system rung', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const [status] = yield* ensureManagedBinaries({
			tartHome: home,
			memoize: false,
			disableDownloads: true,
			env: emptyEnv,
			which: whichOf({ 'ast-grep': '/usr/bin/ast-grep' }),
			exec: extractingExec('unused', 'ast-grep 0.39.6'),
			registry: [definitionOf({ name: 'ast-grep', systemNames: ['ast-grep'], minVersion: '0.44.0' })],
		})

		// Not 'system': the old binary was rejected; with downloads disabled the ladder ends unavailable.
		expect(status?.resolution).toBe('unavailable')
		expect(status?.detail).toContain('downloads disabled')
	}),
)

it.effect('an already-installed managed binary resolves without downloading', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		mkdirSync(managedBinDir(home), { recursive: true })
		writeFileSync(join(managedBinDir(home), 'rg'), binaryBytes)
		const download = recordingDownload(binaryBytes)

		const [status] = yield* ensureManagedBinaries({
			tartHome: home,
			memoize: false,
			env: emptyEnv,
			which: whichOf({}),
			download: download.seam,
			registry: [definitionOf()],
		})

		expect(status?.resolution).toBe('managed')
		expect(status?.path).toBe(join(managedBinDir(home), 'rg'))
		expect(download.urls).toEqual([])
	}),
)

it.effect('a missing binary downloads, extracts, and installs into <tartHome>/bin', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const download = recordingDownload(binaryBytes)

		const [status] = yield* ensureManagedBinaries({
			tartHome: home,
			memoize: false,
			env: emptyEnv,
			which: whichOf({}),
			download: download.seam,
			exec: extractingExec('rg-1.0.0/rg'),
			registry: [definitionOf()],
		})

		expect(status?.resolution).toBe('installed-now')
		expect(status?.path).toBe(join(managedBinDir(home), 'rg'))
		expect(existsSync(join(managedBinDir(home), 'rg'))).toBe(true)
		expect(download.urls).toEqual(['https://example.com/rg-1.0.0.tar.gz'])
	}),
)

it.effect('a sha256 mismatch degrades to unavailable and writes nothing', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const [status] = yield* ensureManagedBinaries({
			tartHome: home,
			memoize: false,
			env: emptyEnv,
			which: whichOf({}),
			download: recordingDownload(binaryBytes).seam,
			exec: extractingExec('rg-1.0.0/rg'),
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
		})

		expect(status?.resolution).toBe('unavailable')
		expect(status?.detail).toContain('sha256 mismatch')
		expect(existsSync(join(managedBinDir(home), 'rg'))).toBe(false)
	}),
)

it.effect('the env kill switch skips downloads entirely', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const download = recordingDownload(binaryBytes)

		const [status] = yield* ensureManagedBinaries({
			tartHome: home,
			memoize: false,
			env: (name) => (name === TART_DISABLE_BINARY_DOWNLOADS ? '1' : undefined),
			which: whichOf({}),
			download: download.seam,
			registry: [definitionOf()],
		})

		expect(status?.resolution).toBe('unavailable')
		expect(download.urls).toEqual([])
	}),
)

it.effect('one failing binary never blocks the rest (ensure never fails)', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const failingDownload: DownloadSeam = (url) =>
			Effect.fail(new BinaryDownloadError({ message: `GET ${url}: network down` }))

		const statuses = yield* ensureManagedBinaries({
			tartHome: home,
			memoize: false,
			env: emptyEnv,
			which: whichOf({ fd: '/usr/bin/fd' }),
			download: failingDownload,
			registry: [definitionOf(), definitionOf({ name: 'fd', systemNames: ['fd'] })],
		})

		expect(statuses.map((status) => status.resolution)).toEqual(['unavailable', 'system'])
		expect(statuses[0]?.detail).toContain('network down')
	}),
)

it.effect('an exec failure during extraction also degrades to unavailable', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const brokenExec: ExecSeam = (command, args) =>
			Effect.fail(new BinaryExecError({ message: `${command} ${args.join(' ')}: exploded` }))

		const [status] = yield* ensureManagedBinaries({
			tartHome: home,
			memoize: false,
			env: emptyEnv,
			which: whichOf({}),
			download: recordingDownload(binaryBytes).seam,
			exec: brokenExec,
			registry: [definitionOf()],
		})

		expect(status?.resolution).toBe('unavailable')
		expect(status?.detail).toContain('exploded')
	}),
)

it.effect('memoized ensures share one resolution pass per (tartHome, mode)', () =>
	Effect.gen(function* () {
		const home = yield* tempDir
		const download = recordingDownload(binaryBytes)
		const options = {
			tartHome: home,
			env: emptyEnv,
			which: whichOf({}),
			download: download.seam,
			exec: extractingExec('rg-1.0.0/rg'),
			registry: [definitionOf()],
		}

		const first = yield* ensureManagedBinaries(options)
		const second = yield* ensureManagedBinaries(options)

		expect(first[0]?.resolution).toBe('installed-now')
		expect(second[0]?.resolution).toBe('installed-now')
		// One download despite two ensure calls: the memoized run was shared.
		expect(download.urls).toEqual(['https://example.com/rg-1.0.0.tar.gz'])
	}),
)

it('parseBinaryVersion pulls the first semver triple out of arbitrary --version output', () => {
	expect(parseBinaryVersion('ripgrep 15.1.0 (rev abc)')).toEqual([15, 1, 0])
	expect(parseBinaryVersion('ast-grep 0.44.1')).toEqual([0, 44, 1])
	expect(parseBinaryVersion('no digits here')).toBeNull()
})
