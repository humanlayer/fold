import { createHash } from 'node:crypto'

import { Array as Arr, Effect, FileSystem, Option, Path, Schema } from 'effect'

export const CodexPluginDiagnostic = Schema.Struct({
	stage: Schema.Literals(['config', 'cache', 'manifest']),
	code: Schema.String,
	path: Schema.String,
})
export type CodexPluginDiagnostic = typeof CodexPluginDiagnostic.Type

export type CodexPluginSkillRoot = {
	readonly name: string
	readonly path: string
	readonly identityToken: string
	readonly versionToken: string
}

export type CodexPluginOptions = {
	readonly codexHome: string
}

type EnabledPlugin = { readonly name: string; readonly marketplace: string }

const token = (kind: string, value: string): string =>
	`${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`

const parseEnabledPlugins = (contents: string): ReadonlyArray<EnabledPlugin> => {
	if (/^\s*plugins\s*=\s*false\s*$/m.test(contents)) return []
	const plugins: Array<EnabledPlugin> = []
	const lines = contents.split(/\r?\n/)
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^\s*\[plugins\."([^"\\/]+)@([^"\\/]+)"\]\s*$/.exec(lines[index] ?? '')
		if (match === null) continue
		const body: Array<string> = []
		for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
			const line = lines[bodyIndex] ?? ''
			if (/^\s*\[/.test(line)) break
			body.push(line)
		}
		if (body.some((line) => /^\s*enabled\s*=\s*false\s*$/.test(line))) continue
		const name = match[1]
		const marketplace = match[2]
		if (name !== undefined && marketplace !== undefined) plugins.push({ name, marketplace })
	}
	return plugins
}

type SemanticVersion = {
	readonly major: string
	readonly minor: string
	readonly patch: string
	readonly prerelease: Array<string>
}

const CodexPluginManifest = Schema.Struct({
	name: Schema.optional(Schema.String),
	skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
})
type CodexPluginManifest = typeof CodexPluginManifest.Type
const decodeCodexPluginManifest = Schema.decodeOption(Schema.fromJsonString(CodexPluginManifest))

const parseSemanticVersion = (value: string): SemanticVersion | null => {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
	if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null
	return { major: match[1], minor: match[2], patch: match[3], prerelease: match[4]?.split('.') ?? [] }
}

const compareNumeric = (left: string, right: string): number =>
	left.length === right.length ? left.localeCompare(right) : left.length - right.length

const compareVersions = (left: string, right: string): number => {
	const leftVersion = parseSemanticVersion(left)
	const rightVersion = parseSemanticVersion(right)
	if (leftVersion === null || rightVersion === null) return left.localeCompare(right)
	for (const field of ['major', 'minor', 'patch'] as const) {
		const compared = compareNumeric(leftVersion[field], rightVersion[field])
		if (compared !== 0) return compared
	}
	if (Arr.isArrayEmpty(leftVersion.prerelease) || Arr.isArrayEmpty(rightVersion.prerelease)) {
		return leftVersion.prerelease.length === rightVersion.prerelease.length
			? 0
			: Arr.isArrayEmpty(leftVersion.prerelease)
				? 1
				: -1
	}
	return leftVersion.prerelease.join('.').localeCompare(rightVersion.prerelease.join('.'))
}

const selectedVersion = (versions: ReadonlyArray<string>): string | null => {
	if (versions.includes('local')) return 'local'
	return versions.reduce<string | null>(
		(selected, version) => (selected === null || compareVersions(selected, version) < 0 ? version : selected),
		null,
	)
}

const safeRelativeSkillRoot = (value: string): string | null => {
	if (!value.startsWith('./') || value === './' || value.includes('\\') || value.includes('\0')) return null
	if (value.split('/').includes('..')) return null
	return value
}

export const discoverCodexPluginSkillRoots = (options: CodexPluginOptions) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const diagnostics: Array<CodexPluginDiagnostic> = []
		const configPath = path.join(options.codexHome, 'config.toml')
		const config = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ''))
		const roots: Array<CodexPluginSkillRoot> = []
		for (const plugin of parseEnabledPlugins(config)) {
			const identity = `${plugin.name}@${plugin.marketplace}`
			const cachePath = path.join(options.codexHome, 'plugins', 'cache', plugin.marketplace, plugin.name)
			const entries = yield* fs.readDirectory(cachePath).pipe(Effect.orElseSucceed(() => []))
			const directories: Array<string> = []
			for (const entry of entries) {
				const info = yield* fs.stat(path.join(cachePath, entry)).pipe(Effect.orElseSucceed(() => null))
				if (info?.type === 'Directory') directories.push(entry)
			}
			const version = selectedVersion(directories)
			if (version === null) continue
			const bundle = path.resolve(cachePath, version)
			let manifest: CodexPluginManifest | null = null
			let manifestPath = ''
			for (const relativePath of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
				const candidate = path.join(bundle, relativePath)
				const contents = yield* fs.readFileString(candidate).pipe(Effect.orElseSucceed(() => null))
				if (contents === null) continue
				manifestPath = candidate
				manifest = Option.getOrNull(decodeCodexPluginManifest(contents))
				if (manifest === null)
					diagnostics.push({ stage: 'manifest', code: 'manifest_parse_failed', path: candidate })
				break
			}
			if (manifest === null) continue
			if (manifest.name !== plugin.name) {
				diagnostics.push({ stage: 'manifest', code: 'manifest_name_mismatch', path: manifestPath })
				continue
			}
			const declared = Arr.ensure(manifest.skills ?? './skills')
			for (const value of declared) {
				const relativeRoot = safeRelativeSkillRoot(value)
				if (relativeRoot === null) {
					diagnostics.push({ stage: 'manifest', code: 'invalid_skill_root', path: manifestPath })
					continue
				}
				roots.push({
					name: plugin.name,
					path: path.resolve(bundle, relativeRoot),
					identityToken: token('plugin', identity),
					versionToken: token('version', version),
				})
			}
		}
		return { roots, diagnostics }
	})
