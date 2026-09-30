import { chmod, cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { Schema } from 'effect'

import {
	internal,
	jsonDocument,
	libraries,
	readJson,
	root,
	RootManifest,
	stage,
	StringRecord,
	targetName,
	targets,
} from './manifest'

const version = parseArgs({ options: { version: { type: 'string' } } }).values.version
if (!version?.match(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/))
	throw new Error('A valid --version is required')
const DependencyMap = Schema.Record(Schema.String, Schema.mutableKey(Schema.optional(Schema.String)))
const ExportValue = Schema.NullOr(Schema.Union([Schema.String, StringRecord]))
type ExportValue = typeof ExportValue.Type
const manifestFields = {
	name: Schema.optionalKey(Schema.String),
	version: Schema.mutableKey(Schema.optionalKey(Schema.String)),
	private: Schema.mutableKey(Schema.optionalKey(Schema.Boolean)),
	publishConfig: Schema.mutableKey(Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))),
	dependencies: Schema.optionalKey(DependencyMap),
	peerDependencies: Schema.optionalKey(DependencyMap),
	optionalDependencies: Schema.optionalKey(DependencyMap),
	bin: Schema.mutableKey(Schema.optionalKey(StringRecord)),
}
const otherManifestFields = [Schema.Record(Schema.String, Schema.mutableKey(Schema.optional(Schema.Unknown)))] as const
const PackageManifest = Schema.StructWithRest(
	Schema.Struct({ ...manifestFields, exports: Schema.Record(Schema.String, Schema.mutableKey(ExportValue)) }),
	otherManifestFields,
)
const PlatformManifest = Schema.StructWithRest(Schema.Struct(manifestFields), otherManifestFields)
type PackageManifest = typeof PackageManifest.Type
const Repository = Schema.Struct({ type: Schema.String, url: Schema.String })
const NativePackageManifest = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
	description: Schema.String,
	license: Schema.String,
	repository: Repository,
	preferUnplugged: Schema.Boolean,
	os: Schema.Array(Schema.String),
	cpu: Schema.Array(Schema.String),
	libc: Schema.mutableKey(Schema.optionalKey(Schema.Array(Schema.String))),
	files: Schema.Array(Schema.String),
	publishConfig: Schema.Struct({ access: Schema.String }),
})
type NativePackageManifest = typeof NativePackageManifest.Type

const rootManifest = await readJson(join(root, 'package.json'), RootManifest)
const catalog = rootManifest.workspaces.catalog
const repository: typeof Repository.Type = { type: 'git', url: 'git+https://github.com/humanlayer/fold.git' }
await rm(stage, { recursive: true, force: true })

function dependencies(manifest: PackageManifest) {
	for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
		const dependencyMap = manifest[field]
		if (dependencyMap === undefined) continue
		for (const [name, range] of Object.entries(dependencyMap)) {
			if (range === 'catalog:')
				dependencyMap[name] =
					catalog[name] ??
					(() => {
						throw new Error(`Missing catalog entry ${name}`)
					})()
			if (typeof range === 'string' && range.startsWith('workspace:')) {
				if (internal.has(name)) delete dependencyMap[name]
				else dependencyMap[name] = version
			}
		}
	}
}

for (const packageDir of libraries) {
	const source = join(root, 'packages', packageDir)
	const dest = join(stage, 'packages', packageDir)
	const manifest = await readJson(join(source, 'package.json'), PackageManifest)
	manifest.version = version
	manifest.private = false
	manifest.publishConfig = { ...manifest.publishConfig, access: 'public' }
	manifest.repository = { ...repository, directory: `packages/${packageDir}` }
	manifest.homepage = 'https://github.com/humanlayer/fold#readme'
	manifest.bugs = { url: 'https://github.com/humanlayer/fold/issues' }
	delete manifest.devDependencies
	delete manifest.source
	dependencies(manifest)
	const rewrite = (value: string) => value.replace(/^\.\/src\//, './dist/').replace(/\.(tsx?|jsx?)$/, '.js')
	const dts = (value: string) => rewrite(value).replace(/\.js$/, '.d.ts')
	const sourcePath = (value: ExportValue | undefined) =>
		typeof value === 'string' ? value : (value?.source ?? value?.import)
	const isSourceModule = (value: string) => /^\.\/src\/.*\.(?:[cm]?[jt]sx?)$/.test(value)
	const mainSource = sourcePath(manifest.exports['.'])
	if (mainSource === undefined || !isSourceModule(mainSource))
		throw new Error(`${manifest.name} must provide a TypeScript root export`)
	for (const [key, value] of Object.entries(manifest.exports)) {
		const source = sourcePath(value)
		if (source === undefined || !isSourceModule(source)) continue
		manifest.exports[key] = { types: dts(source), import: rewrite(source), default: rewrite(source) }
	}
	manifest.module = rewrite(mainSource)
	manifest.types = dts(mainSource)
	if (manifest.bin !== undefined)
		manifest.bin = Object.fromEntries(Object.entries(manifest.bin).map(([name, value]) => [name, rewrite(value)]))
	await mkdir(dest, { recursive: true })
	await cp(join(source, 'dist'), join(dest, 'dist'), { recursive: true })
	for (const executable of new Set(Object.values(manifest.bin ?? {}))) await chmod(join(dest, executable), 0o755)
	for (const file of [
		'README.md',
		'LICENSE',
		'NOTICE',
		'LICENSE.opencode',
		'ATTRIBUTION.md',
		'UPSTREAM.md',
		'UPSTREAM.sha256',
	])
		if (await Bun.file(join(source, file)).exists()) await cp(join(source, file), join(dest, file))
	if (!(await Bun.file(join(dest, 'LICENSE')).exists())) await cp(join(root, 'LICENSE'), join(dest, 'LICENSE'))
	await Bun.write(join(dest, 'package.json'), jsonDocument(PackageManifest, manifest))
}

const optionalDependencies = Object.fromEntries(targets.map((target) => [targetName(target), version]))
for (const target of targets) {
	const name = targetName(target)
	const source = join(root, 'dist', name.replace('@humanlayer/', ''))
	const dest = join(stage, 'native', name.replace('@humanlayer/', ''))
	await mkdir(dest, { recursive: true })
	await cp(join(source, 'bin'), join(dest, 'bin'), { recursive: true })
	const [os, cpu, variant] = target
	const manifest: NativePackageManifest = {
		name,
		version,
		description: 'Platform binary for @humanlayer/fold',
		license: 'MIT',
		repository,
		preferUnplugged: true,
		os: [os === 'windows' ? 'win32' : os],
		cpu: [cpu],
		files: ['bin'],
		publishConfig: { access: 'public' },
	}
	if (variant.includes('musl')) manifest.libc = ['musl']
	await Bun.write(join(dest, 'package.json'), jsonDocument(NativePackageManifest, manifest))
	await cp(join(root, 'LICENSE'), join(dest, 'LICENSE'))
}
const platform = await readJson(join(root, 'packages/fold/package.json'), PlatformManifest)
Object.assign(platform, {
	version,
	private: false,
	description: 'Effect-native, provider-agnostic agent loop and foldcode terminal application',
	repository: { ...repository, directory: 'packages/fold' },
	homepage: 'https://github.com/humanlayer/fold#readme',
	bugs: { url: 'https://github.com/humanlayer/fold/issues' },
	optionalDependencies,
	publishConfig: { access: 'public' },
})
const platformDest = join(stage, 'packages/fold')
await mkdir(platformDest, { recursive: true })
await cp(join(root, 'packages/fold/postinstall.mjs'), join(platformDest, 'postinstall.mjs'))
await cp(join(root, 'LICENSE'), join(platformDest, 'LICENSE'))
await mkdir(join(platformDest, 'bin'), { recursive: true })
await Bun.write(
	join(platformDest, 'bin/foldcode.exe'),
	"#!/usr/bin/env node\nthrow new Error('foldcode native binary was not installed')\n",
)
await chmod(join(platformDest, 'bin/foldcode.exe'), 0o755)
await Bun.write(join(platformDest, 'package.json'), jsonDocument(PlatformManifest, platform))
