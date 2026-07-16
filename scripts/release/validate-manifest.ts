import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { json, libraries, stage, targetName, targets } from './manifest'

const expectedVersion = process.argv.find((_, index, args) => args[index - 1] === '--version')
const manifests = [
	...libraries.map((name) => join(stage, 'packages', name, 'package.json')),
	...targets.map((target) => join(stage, 'native', targetName(target).replace('@humanlayer/', ''), 'package.json')),
	join(stage, 'packages/fold/package.json'),
]
for (const path of manifests) {
	const manifest = await json(path)
	if (expectedVersion !== undefined && manifest.version !== expectedVersion)
		throw new Error(`${manifest.name} is ${manifest.version}, expected ${expectedVersion}`)
	if (manifest.private) throw new Error(`${manifest.name} is private`)
	if (manifest.publishConfig?.access !== 'public') throw new Error(`${manifest.name} is not public`)
	for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
		for (const [name, range] of Object.entries(manifest[field] ?? {})) {
			if (String(range).includes('workspace:') || range === 'catalog:')
				throw new Error(`${manifest.name} has unresolved ${field} ${name}`)
			if (name.startsWith('@humanlayer/fold') && range !== manifest.version)
				throw new Error(`${manifest.name} does not exactly pin ${name}`)
		}
	}
	if (manifest.exports && JSON.stringify(manifest.exports).includes('/src/'))
		throw new Error(`${manifest.name} exposes source files`)
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
