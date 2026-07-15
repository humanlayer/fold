/**
 * This file is the data half of fold's managed binaries (D18): the pinned registry of the external
 * binaries agent prompts rely on - `rg` (ripgrep), `fd`, and `ast-grep` - with one verified GitHub
 * release asset per supported platform. Every version, asset name, archive layout, and inner binary
 * path below was read from the upstream release at pin time (2026-07-09), not guessed; the sha256
 * digests live in the generated `BinaryChecksums.ts` table. After changing any pin, regenerate the
 * digests with `bun packages/fold-agent/scripts/update-managed-binaries.ts`.
 *
 * Platform notes baked into the pins: ripgrep ships musl for linux-x64 but only gnu for linux-arm64;
 * fd stopped publishing darwin-x64 archives after 10.3.0, so that one platform pins the older
 * version (pi does the same); ast-grep ships zip archives on every platform, unix included.
 */
import { managedBinaryChecksums } from './BinaryChecksums'

/** One platform key the registry pins assets for, shaped as `${process.platform}-${process.arch}`. */
export type ManagedBinaryPlatform = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'win32-x64'

/** Every platform the registry pins assets for (the checksum generator downloads each of these). */
export const MANAGED_BINARY_PLATFORMS: ReadonlyArray<ManagedBinaryPlatform> = [
	'darwin-arm64',
	'darwin-x64',
	'linux-x64',
	'linux-arm64',
	'win32-x64',
]

/** One downloadable release asset: where it lives, how it unpacks, and where the binary sits inside. */
export type ManagedBinaryAsset = {
	/** Release-asset download URL with the pinned version baked in. */
	readonly url: string
	/** Archive format; extraction shells out to the system `tar`/`unzip`. */
	readonly archive: 'tar.gz' | 'zip'
	/** Path of the executable inside the extracted archive, relative to the extraction root. */
	readonly pathInArchive: string
	/** Pinned sha256 hex digest of the archive; null skips verification (asset not in the table). */
	readonly sha256: string | null
}

/** One managed binary: identity, system aliases, version floor, and its per-platform assets. */
export type ManagedBinaryDefinition = {
	/** Canonical name - the file name installed into `<foldHome>/bin` and the one prompts use. */
	readonly name: string
	/** GitHub `owner/repo` the pinned release comes from. */
	readonly repo: string
	/** Pinned release version installed when no usable binary is found. */
	readonly version: string
	/** Command names accepted as a system-provided equivalent (aliases like Debian's `fdfind`). */
	readonly systemNames: ReadonlyArray<string>
	/**
	 * Minimum usable version for SYSTEM binaries, or null when any version is usable. A system
	 * binary whose `--version` output cannot be parsed or reports an older version is treated as
	 * absent so the managed install still happens.
	 */
	readonly minVersion: string | null
	/** The pinned release asset for one platform, or null when the platform is unsupported. */
	readonly assetFor: (platform: string, arch: string) => ManagedBinaryAsset | null
}

const releaseAsset = (input: {
	readonly repo: string
	readonly tag: string
	readonly assetName: string
	readonly archive: 'tar.gz' | 'zip'
	readonly pathInArchive: string
}): ManagedBinaryAsset => {
	const url = `https://github.com/${input.repo}/releases/download/${input.tag}/${input.assetName}`
	return {
		url,
		archive: input.archive,
		pathInArchive: input.pathInArchive,
		sha256: managedBinaryChecksums[url] ?? null,
	}
}

const assetLookup =
	(assets: Readonly<Record<string, ManagedBinaryAsset>>) =>
	(platform: string, arch: string): ManagedBinaryAsset | null =>
		assets[`${platform}-${arch}`] ?? null

// ripgrep tags carry no `v` prefix; archives nest under `ripgrep-<version>-<triple>/`.
const rgAssets = {
	'darwin-arm64': releaseAsset({
		repo: 'BurntSushi/ripgrep',
		tag: '15.1.0',
		assetName: 'ripgrep-15.1.0-aarch64-apple-darwin.tar.gz',
		archive: 'tar.gz',
		pathInArchive: 'ripgrep-15.1.0-aarch64-apple-darwin/rg',
	}),
	'darwin-x64': releaseAsset({
		repo: 'BurntSushi/ripgrep',
		tag: '15.1.0',
		assetName: 'ripgrep-15.1.0-x86_64-apple-darwin.tar.gz',
		archive: 'tar.gz',
		pathInArchive: 'ripgrep-15.1.0-x86_64-apple-darwin/rg',
	}),
	// musl: the static build, safe on any distro (upstream ships no musl arm64, hence gnu below).
	'linux-x64': releaseAsset({
		repo: 'BurntSushi/ripgrep',
		tag: '15.1.0',
		assetName: 'ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz',
		archive: 'tar.gz',
		pathInArchive: 'ripgrep-15.1.0-x86_64-unknown-linux-musl/rg',
	}),
	'linux-arm64': releaseAsset({
		repo: 'BurntSushi/ripgrep',
		tag: '15.1.0',
		assetName: 'ripgrep-15.1.0-aarch64-unknown-linux-gnu.tar.gz',
		archive: 'tar.gz',
		pathInArchive: 'ripgrep-15.1.0-aarch64-unknown-linux-gnu/rg',
	}),
	'win32-x64': releaseAsset({
		repo: 'BurntSushi/ripgrep',
		tag: '15.1.0',
		assetName: 'ripgrep-15.1.0-x86_64-pc-windows-msvc.zip',
		archive: 'zip',
		pathInArchive: 'ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe',
	}),
} satisfies Record<ManagedBinaryPlatform, ManagedBinaryAsset>

// fd tags carry a `v` prefix; archives nest under `fd-v<version>-<triple>/`. darwin-x64 pins 10.3.0
// because 10.4.x ships no x86_64-apple-darwin archive.
const fdAssets = {
	'darwin-arm64': releaseAsset({
		repo: 'sharkdp/fd',
		tag: 'v10.4.2',
		assetName: 'fd-v10.4.2-aarch64-apple-darwin.tar.gz',
		archive: 'tar.gz',
		pathInArchive: 'fd-v10.4.2-aarch64-apple-darwin/fd',
	}),
	'darwin-x64': releaseAsset({
		repo: 'sharkdp/fd',
		tag: 'v10.3.0',
		assetName: 'fd-v10.3.0-x86_64-apple-darwin.tar.gz',
		archive: 'tar.gz',
		pathInArchive: 'fd-v10.3.0-x86_64-apple-darwin/fd',
	}),
	'linux-x64': releaseAsset({
		repo: 'sharkdp/fd',
		tag: 'v10.4.2',
		assetName: 'fd-v10.4.2-x86_64-unknown-linux-musl.tar.gz',
		archive: 'tar.gz',
		pathInArchive: 'fd-v10.4.2-x86_64-unknown-linux-musl/fd',
	}),
	'linux-arm64': releaseAsset({
		repo: 'sharkdp/fd',
		tag: 'v10.4.2',
		assetName: 'fd-v10.4.2-aarch64-unknown-linux-musl.tar.gz',
		archive: 'tar.gz',
		pathInArchive: 'fd-v10.4.2-aarch64-unknown-linux-musl/fd',
	}),
	'win32-x64': releaseAsset({
		repo: 'sharkdp/fd',
		tag: 'v10.4.2',
		assetName: 'fd-v10.4.2-x86_64-pc-windows-msvc.zip',
		archive: 'zip',
		pathInArchive: 'fd-v10.4.2-x86_64-pc-windows-msvc/fd.exe',
	}),
} satisfies Record<ManagedBinaryPlatform, ManagedBinaryAsset>

// ast-grep tags carry no `v` prefix; every asset is a zip named `app-<triple>.zip` with the
// `ast-grep` binary (and its `sg` alias) at the archive root.
const astGrepAssets = {
	'darwin-arm64': releaseAsset({
		repo: 'ast-grep/ast-grep',
		tag: '0.44.1',
		assetName: 'app-aarch64-apple-darwin.zip',
		archive: 'zip',
		pathInArchive: 'ast-grep',
	}),
	'darwin-x64': releaseAsset({
		repo: 'ast-grep/ast-grep',
		tag: '0.44.1',
		assetName: 'app-x86_64-apple-darwin.zip',
		archive: 'zip',
		pathInArchive: 'ast-grep',
	}),
	'linux-x64': releaseAsset({
		repo: 'ast-grep/ast-grep',
		tag: '0.44.1',
		assetName: 'app-x86_64-unknown-linux-gnu.zip',
		archive: 'zip',
		pathInArchive: 'ast-grep',
	}),
	'linux-arm64': releaseAsset({
		repo: 'ast-grep/ast-grep',
		tag: '0.44.1',
		assetName: 'app-aarch64-unknown-linux-gnu.zip',
		archive: 'zip',
		pathInArchive: 'ast-grep',
	}),
	'win32-x64': releaseAsset({
		repo: 'ast-grep/ast-grep',
		tag: '0.44.1',
		assetName: 'app-x86_64-pc-windows-msvc.zip',
		archive: 'zip',
		pathInArchive: 'ast-grep.exe',
	}),
} satisfies Record<ManagedBinaryPlatform, ManagedBinaryAsset>

/**
 * The managed-binary registry: `rg`, `fd`, and `ast-grep` (D18). ast-grep's 0.44.0 floor is the
 * release that added `ast-grep outline`, which the subagent prompts depend on; note that shadow-utils
 * also ships an unrelated `sg` on some distros, and the same version parse that enforces the floor
 * rejects it (its `--version` output never parses as an ast-grep version).
 */
export const managedBinaryRegistry: ReadonlyArray<ManagedBinaryDefinition> = [
	{
		name: 'rg',
		repo: 'BurntSushi/ripgrep',
		version: '15.1.0',
		systemNames: ['rg'],
		minVersion: null,
		assetFor: assetLookup(rgAssets),
	},
	{
		name: 'fd',
		repo: 'sharkdp/fd',
		version: '10.4.2',
		systemNames: ['fd', 'fdfind'],
		minVersion: null,
		assetFor: assetLookup(fdAssets),
	},
	{
		name: 'ast-grep',
		repo: 'ast-grep/ast-grep',
		version: '0.44.1',
		systemNames: ['ast-grep', 'sg'],
		minVersion: '0.44.0',
		assetFor: assetLookup(astGrepAssets),
	},
]
