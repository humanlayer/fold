import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { libraries, root, json } from '../release/manifest'

const version = process.argv.find((_, index, args) => args[index - 1] === '--version') ?? '0.0.0'
const { default: solidTransformPlugin } = await import(
	join(root, 'packages/fold-cli/node_modules/@opentui/solid/scripts/solid-plugin.js')
)

for (const name of libraries) {
	const dir = join(root, 'packages', name)
	const manifest = await json<{
		name: string
		exports: Record<string, string | { source?: string }>
		bin?: Record<string, string>
	}>(join(dir, 'package.json'))
	const exports = Object.values(manifest.exports)
	const entries = exports
		.map((value) => (typeof value === 'string' ? value : value.source))
		.filter((entry): entry is string => entry !== undefined)
	for (const entry of Object.values(manifest.bin ?? {})) {
		const sourceEntry = entry.replace(/^(?:\.\/)?dist\//, './src/').replace(/\.js$/, '.ts')
		if (!entries.includes(sourceEntry)) entries.push(sourceEntry)
	}
	const outdir = join(dir, 'dist')
	await rm(outdir, { recursive: true, force: true })
	await mkdir(outdir, { recursive: true })
	const result = await Bun.build({
		entrypoints: entries.map((entry) => join(dir, entry)),
		outdir,
		root: join(dir, 'src'),
		target: 'node',
		format: 'esm',
		packages: name === 'fold-cli' ? 'bundle' : 'external',
		external: name === 'fold-cli' ? ['@opentui/core', '@opentui/core/*'] : [],
		sourcemap: 'external',
		plugins: name === 'fold-cli' ? [solidTransformPlugin] : [],
		define: name === 'fold-cli' ? { FOLD_VERSION: JSON.stringify(version) } : {},
	})
	if (!result.success) throw new AggregateError(result.logs, `Failed to build ${manifest.name}`)
	const buildConfig = join(dir, 'tsconfig.release.json')
	await Bun.write(
		buildConfig,
		`${JSON.stringify({ extends: './tsconfig.json', compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: './dist', rootDir: './src' }, include: ['src'], exclude: ['test', 'examples', 'scripts'] }, null, 2)}\n`,
	)
	const declaration = Bun.spawn(['bunx', 'tsc', '-p', buildConfig], {
		cwd: root,
		stdout: 'inherit',
		stderr: 'inherit',
	})
	const declarationExit = await declaration.exited
	await rm(buildConfig, { force: true })
	if (declarationExit !== 0) throw new Error(`Failed to emit declarations for ${manifest.name}`)
	console.log(`built ${manifest.name}`)
}
