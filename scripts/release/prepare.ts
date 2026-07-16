import { chmod, cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { internal, json, libraries, root, stage, targetName, targets } from './manifest'

const version = parseArgs({ options: { version: { type: 'string' } } }).values.version
if (!version?.match(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/))
	throw new Error('A valid --version is required')
const rootManifest = await json(join(root, 'package.json'))
const catalog = rootManifest.workspaces.catalog as Record<string, string>
const repository = { type: 'git', url: 'git+https://github.com/humanlayer/fold.git' }
await rm(stage, { recursive: true, force: true })

function dependencies(manifest: Record<string, any>) {
	for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
		for (const [name, range] of Object.entries(manifest[field] ?? {})) {
			if (range === 'catalog:')
				manifest[field][name] =
					catalog[name] ??
					(() => {
						throw new Error(`Missing catalog entry ${name}`)
					})()
			if (typeof range === 'string' && range.startsWith('workspace:')) {
				if (internal.has(name)) delete manifest[field][name]
				else manifest[field][name] = version
			}
		}
	}
}

for (const packageDir of libraries) {
	const source = join(root, 'packages', packageDir)
	const dest = join(stage, 'packages', packageDir)
	const manifest = structuredClone(await json(join(source, 'package.json')))
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
	for (const [key, value] of Object.entries(manifest.exports as Record<string, any>)) {
		const sourcePath = typeof value === 'string' ? value : value.source
		manifest.exports[key] = { types: dts(sourcePath), import: rewrite(sourcePath), default: rewrite(sourcePath) }
	}
	const mainSource =
		typeof Object.values((await json(join(source, 'package.json'))).exports)[0] === 'string'
			? (Object.values((await json(join(source, 'package.json'))).exports)[0] as string)
			: './src/index.ts'
	manifest.module = rewrite(mainSource)
	manifest.types = dts(mainSource)
	if (manifest.bin)
		manifest.bin = Object.fromEntries(
			Object.entries(manifest.bin as Record<string, string>).map(([name, value]) => [name, rewrite(value)]),
		)
	await mkdir(dest, { recursive: true })
	await cp(join(source, 'dist'), join(dest, 'dist'), { recursive: true })
	for (const executable of new Set(Object.values((manifest.bin ?? {}) as Record<string, string>)))
		await chmod(join(dest, executable), 0o755)
	for (const file of ['README.md', 'LICENSE', 'NOTICE', 'LICENSE.opencode', 'ATTRIBUTION.md'])
		if (await Bun.file(join(source, file)).exists()) await cp(join(source, file), join(dest, file))
	if (!(await Bun.file(join(dest, 'LICENSE')).exists())) await cp(join(root, 'LICENSE'), join(dest, 'LICENSE'))
	await Bun.write(join(dest, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

const optionalDependencies = Object.fromEntries(targets.map((target) => [targetName(target), version]))
for (const target of targets) {
	const name = targetName(target)
	const source = join(root, 'dist', name.replace('@humanlayer/', ''))
	const dest = join(stage, 'native', name.replace('@humanlayer/', ''))
	await mkdir(dest, { recursive: true })
	await cp(join(source, 'bin'), join(dest, 'bin'), { recursive: true })
	const [os, cpu, variant] = target
	await Bun.write(
		join(dest, 'package.json'),
		`${JSON.stringify({ name, version, description: 'Platform binary for @humanlayer/fold', license: 'MIT', repository, preferUnplugged: true, os: [os === 'windows' ? 'win32' : os], cpu: [cpu], ...(variant.includes('musl') ? { libc: ['musl'] } : {}), files: ['bin'], publishConfig: { access: 'public' } }, null, 2)}\n`,
	)
	await cp(join(root, 'LICENSE'), join(dest, 'LICENSE'))
}
const platform = await json(join(root, 'packages/fold/package.json'))
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
await Bun.write(join(platformDest, 'package.json'), `${JSON.stringify(platform, null, 2)}\n`)
