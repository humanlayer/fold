import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { json, libraries, root, stage, targetName, targets } from './manifest'

type ExportValue = string | { types?: string; import?: string; default?: string } | null

const providerPackages = new Set([
	'@humanlayer/effect-ai-openai',
	'@humanlayer/effect-ai-anthropic',
	'@humanlayer/effect-ai-openai-compat',
])

const providerDependencies = new Map([
	['@humanlayer/fold-core', ['@humanlayer/effect-ai-anthropic', '@humanlayer/effect-ai-openai']],
	['@humanlayer/fold-codex', ['@humanlayer/effect-ai-openai']],
	['@humanlayer/fold-opencode', ['@humanlayer/effect-ai-openai', '@humanlayer/effect-ai-openai-compat']],
	['@humanlayer/fold-xai', ['@humanlayer/effect-ai-openai-compat']],
])

const externalConsumerPackages = [
	'effect-branded-id',
	'effect-ai-openai',
	'effect-ai-anthropic',
	'effect-ai-openai-compat',
	'fold-core',
]

const exists = async (path: string) => {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

const expandGlob = async (directory: string, pattern: string) => {
	const matches = Array<string>()
	const glob = new Bun.Glob(pattern.replace(/^\.\//, ''))
	for await (const file of glob.scan({ cwd: directory, onlyFiles: true })) matches.push(file)
	return matches
}

const assertNodeImport = async (packageName: string, entrypoint: string) => {
	const expression = `await import(${JSON.stringify(pathToFileURL(entrypoint).href)})`
	const process = Bun.spawn(['node', '--input-type=module', '--eval', expression], {
		stdout: 'inherit',
		stderr: 'inherit',
	})
	if ((await process.exited) !== 0) throw new Error(`${packageName} does not execute with Node.js: ${entrypoint}`)
}

const run = async (command: Array<string>, cwd: string, captureOutput = false) => {
	const child = Bun.spawn(command, {
		cwd,
		stdout: captureOutput ? 'pipe' : 'inherit',
		stderr: 'inherit',
		env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
	})
	const output = captureOutput ? await new Response(child.stdout).text() : ''
	if ((await child.exited) !== 0) throw new Error(`Command failed: ${command.join(' ')}`)
	return output
}

type PackedArchive = { name: string; path: string }
type PackedPackage = { name: string; filename: string }

const isPackedPackage = (value: unknown): value is PackedPackage =>
	typeof value === 'object' &&
	value !== null &&
	'name' in value &&
	typeof value.name === 'string' &&
	'filename' in value &&
	typeof value.filename === 'string'

const pack = async (directory: string, outputDirectory: string): Promise<PackedArchive> => {
	const output = await run(['npm', 'pack', '--json', '--pack-destination', outputDirectory], directory, true)
	const packed: unknown = JSON.parse(output)
	const artifact = Array.isArray(packed)
		? packed.find(isPackedPackage)
		: typeof packed === 'object' && packed !== null
			? Object.values(packed).find(isPackedPackage)
			: undefined
	if (artifact === undefined) throw new Error(`npm pack did not produce an archive for ${directory}`)
	return { name: artifact.name, path: join(outputDirectory, artifact.filename) }
}

const validateExternalProviderConsumer = async (
	manager: 'npm' | 'pnpm',
	archives: Array<PackedArchive>,
	effectVersion: string,
) => {
	const directory = await mkdtemp(join(tmpdir(), `fold-${manager}-provider-consumer-`))
	try {
		const overrides = Object.fromEntries(archives.map((artifact) => [artifact.name, `file:${artifact.path}`]))
		const manifest = {
			name: `fold-${manager}-provider-consumer`,
			private: true,
			type: 'module',
			packageManager: 'pnpm@11.25.0',
		}
		await Bun.write(join(directory, 'package.json'), `${JSON.stringify(manifest)}\n`)
		if (manager === 'pnpm')
			await Bun.write(
				join(directory, 'pnpm-workspace.yaml'),
				`overrides:\n${Object.entries(overrides)
					.map(([name, range]) => `  ${JSON.stringify(name)}: ${JSON.stringify(range)}`)
					.join('\n')}\n`,
			)
		await Bun.write(
			join(directory, 'provider-consumer.mjs'),
			await Bun.file(join(root, 'scripts/release/fixtures/provider-consumer.mjs')).text(),
		)
		const packages = [`effect@${effectVersion}`, ...archives.map((artifact) => artifact.path)]
		const install =
			manager === 'npm'
				? ['npm', 'install', '--ignore-scripts', '--no-package-lock', ...packages]
				: [
						'npm',
						'exec',
						'--yes',
						'--package=pnpm@11.25.0',
						'--',
						'pnpm',
						'install',
						'--ignore-scripts',
						'--lockfile=false',
						...packages,
					]
		await run(install, directory)
		await run(['node', 'provider-consumer.mjs'], directory)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}

const validateExternalProviderConsumers = async () => {
	const archivesDirectory = await mkdtemp(join(tmpdir(), 'fold-provider-archives-'))
	try {
		const archives = await Promise.all(
			externalConsumerPackages.map((name) => pack(join(stage, 'packages', name), archivesDirectory)),
		)
		const manifest = await json<{ peerDependencies: { effect: string } }>(
			join(stage, 'packages/effect-ai-openai/package.json'),
		)
		await validateExternalProviderConsumer('npm', archives, manifest.peerDependencies.effect)
		await validateExternalProviderConsumer('pnpm', archives, manifest.peerDependencies.effect)
	} finally {
		await rm(archivesDirectory, { recursive: true, force: true })
	}
}

const withEffectPeer = async (directory: string, effect: () => Promise<void>) => {
	const nodeModules = join(directory, 'node_modules')
	const peer = join(nodeModules, 'effect')
	await mkdir(nodeModules, { recursive: true })
	await symlink(await realpath(join(root, 'packages/effect-ai-openai/node_modules/effect')), peer)
	try {
		await effect()
	} finally {
		await rm(nodeModules, { recursive: true, force: true })
	}
}

const validateProviderPackage = async (directory: string, name: string, exports: Record<string, ExportValue>) => {
	for (const file of [
		'package.json',
		'README.md',
		'LICENSE',
		'UPSTREAM.md',
		...(name === '@humanlayer/effect-ai-openai-compat' ? ['UPSTREAM.sha256'] : []),
	])
		if (!(await exists(join(directory, file)))) throw new Error(`${name} is missing ${file}`)
	if (await exists(join(directory, 'src'))) throw new Error(`${name} package payload must not contain source files`)

	if (exports['./package.json'] !== './package.json') throw new Error(`${name} must export package.json`)
	for (const key of ['./internal/*', './index', './*/index'])
		if (exports[key] !== null) throw new Error(`${name} must keep ${key} blocked`)

	const root = exports['.']
	const wildcard = exports['./*']
	if (root === null || typeof root === 'string' || wildcard === null || typeof wildcard === 'string')
		throw new Error(`${name} must export root and wildcard ESM/declaration targets`)
	for (const [key, value] of [
		['.', root],
		['./*', wildcard],
	] as const) {
		if (value.types === undefined || value.import === undefined || value.default === undefined)
			throw new Error(`${name} ${key} must export types, import, and default targets`)
	}

	const rootTypes = join(directory, root.types)
	const rootImport = join(directory, root.import)
	if (!(await exists(rootTypes))) throw new Error(`${name} root declaration does not exist: ${root.types}`)
	if (!(await exists(rootImport))) throw new Error(`${name} root ESM does not exist: ${root.import}`)

	const typeFiles = new Set(await expandGlob(directory, wildcard.types))
	const runtimeFiles = await expandGlob(directory, wildcard.import)
	if (typeFiles.size === 0 || runtimeFiles.length === 0)
		throw new Error(`${name} wildcard export must contain runtime and declaration files`)
	await withEffectPeer(directory, async () => {
		await assertNodeImport(name, rootImport)
		for (const runtimeFile of runtimeFiles) {
			const declarationFile = runtimeFile.replace(/\.js$/, '.d.ts')
			if (!typeFiles.has(declarationFile))
				throw new Error(`${name} is missing a declaration for wildcard runtime entrypoint ${runtimeFile}`)
			await assertNodeImport(name, join(directory, runtimeFile))
		}
	})
}

const expectedVersion = process.argv.find((_, index, args) => args[index - 1] === '--version')
const manifests = [
	...libraries.map((name) => join(stage, 'packages', name, 'package.json')),
	...targets.map((target) => join(stage, 'native', targetName(target).replace('@humanlayer/', ''), 'package.json')),
	join(stage, 'packages/fold/package.json'),
]
for (const path of manifests) {
	const manifest = await json<{
		name: string
		version: string
		private?: boolean
		publishConfig?: { access?: string }
		dependencies?: Record<string, string>
		peerDependencies?: Record<string, string>
		optionalDependencies?: Record<string, string>
		exports?: Record<string, ExportValue>
		bin?: Record<string, string>
	}>(path)
	if (expectedVersion !== undefined && manifest.version !== expectedVersion)
		throw new Error(`${manifest.name} is ${manifest.version}, expected ${expectedVersion}`)
	if (manifest.private) throw new Error(`${manifest.name} is private`)
	if (manifest.publishConfig?.access !== 'public') throw new Error(`${manifest.name} is not public`)
	for (const name of new Set([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
	])) {
		if (name !== 'effect' && !name.startsWith('@effect/')) continue
		if (manifest.dependencies?.[name] !== undefined)
			throw new Error(`${manifest.name} must publish ${name} as a peer dependency`)
		if (manifest.peerDependencies?.[name] === undefined)
			throw new Error(`${manifest.name} must declare ${name} as a peer dependency`)
	}
	for (const dependencies of [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies]) {
		for (const [name, range] of Object.entries(dependencies ?? {})) {
			if (String(range).includes('workspace:') || range === 'catalog:')
				throw new Error(`${manifest.name} has unresolved dependency ${name}`)
			if (name.startsWith('@humanlayer/fold') && range !== manifest.version)
				throw new Error(`${manifest.name} does not exactly pin ${name}`)
		}
	}
	for (const provider of providerDependencies.get(manifest.name) ?? []) {
		if (manifest.dependencies?.[provider] !== manifest.version)
			throw new Error(`${manifest.name} must publish ${provider} as an exact normal dependency`)
		if (
			manifest.peerDependencies?.[provider] !== undefined ||
			manifest.optionalDependencies?.[provider] !== undefined
		)
			throw new Error(`${manifest.name} must not publish ${provider} as a peer or optional dependency`)
	}
	if (manifest.exports && JSON.stringify(manifest.exports).includes('/src/'))
		throw new Error(`${manifest.name} exposes source files`)
	if (providerPackages.has(manifest.name)) {
		if (manifest.exports === undefined) throw new Error(`${manifest.name} is missing an export map`)
		await validateProviderPackage(join(path, '..'), manifest.name, manifest.exports)
	}
	if (manifest.name === '@humanlayer/fold-cli') {
		if (manifest.bin?.['fold-cli'] !== 'dist/cli.js' || manifest.bin?.foldcode !== 'dist/cli.js')
			throw new Error('@humanlayer/fold-cli must expose fold-cli and foldcode from the same built entrypoint')
		const cliPath = join(stage, 'packages/fold-cli/dist/cli.js')
		const cli = await Bun.file(cliPath).text()
		if (!cli.startsWith('#!/usr/bin/env node'))
			throw new Error('@humanlayer/fold-cli CLI is missing its Node.js shebang')
		if (((await stat(cliPath)).mode & 0o111) === 0) throw new Error('@humanlayer/fold-cli CLI is not executable')
		const execution = Bun.spawn(['node', cliPath, '--version'], { stdout: 'pipe', stderr: 'inherit' })
		const output = await new Response(execution.stdout).text()
		if ((await execution.exited) !== 0) throw new Error('@humanlayer/fold-cli does not execute with Node.js')
		if (expectedVersion !== undefined && !output.includes(expectedVersion))
			throw new Error(`@humanlayer/fold-cli reports the wrong version: ${output.trim()}`)
	}
	if (manifest.name === '@humanlayer/fold') {
		if (Object.keys(manifest.bin ?? {}).length !== 1 || manifest.bin?.foldcode !== 'bin/foldcode.exe')
			throw new Error('@humanlayer/fold must expose foldcode from the universal launcher')
		if (((await stat(join(stage, 'packages/fold/bin/foldcode.exe'))).mode & 0o111) === 0)
			throw new Error('@humanlayer/fold universal launcher is not executable')
	}
	console.log(`validated ${manifest.name}@${manifest.version}`)
}

await validateExternalProviderConsumers()
