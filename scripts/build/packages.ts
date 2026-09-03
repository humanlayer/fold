import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { libraries, root, json } from '../release/manifest'

const version = process.argv.find((_, index, args) => args[index - 1] === '--version') ?? '0.0.0'
const providersOnly = process.argv.includes('--providers')
const quiet = process.argv.includes('--quiet')
const { default: solidTransformPlugin } = await import(
	join(root, 'packages/fold-cli/node_modules/@opentui/solid/scripts/solid-plugin.js')
)

for (const name of libraries) {
	if (providersOnly && !name.startsWith('effect-ai-')) continue
	const dir = join(root, 'packages', name)
	const manifest = await json<{
		name: string
		exports: Record<string, string | { import?: string; source?: string } | null>
		bin?: Record<string, string>
	}>(join(dir, 'package.json'))
	const entries = new Set<string>()
	for (const value of Object.values(manifest.exports)) {
		const entry = typeof value === 'string' ? value : (value?.source ?? value?.import)
		if (entry === undefined || !/\.[cm]?[jt]sx?$/.test(entry)) continue
		if (!entry.includes('*')) {
			entries.add(entry)
			continue
		}
		const glob = new Bun.Glob(entry.replace(/^\.\//, ''))
		for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) entries.add(`./${file}`)
	}
	for (const entry of Object.values(manifest.bin ?? {})) {
		const sourceEntry = entry.replace(/^(?:\.\/)?dist\//, './src/').replace(/\.js$/, '.ts')
		entries.add(sourceEntry)
	}
	if (entries.size === 0) throw new Error(`No TypeScript entrypoints found for ${manifest.name}`)
	const outdir = join(dir, 'dist')
	await rm(outdir, { recursive: true, force: true })
	await mkdir(outdir, { recursive: true })
	const effectAiProvider = name.startsWith('effect-ai-')
	if (!effectAiProvider) {
		const define: Record<string, string> = {}
		if (name === 'fold-cli') define.FOLD_VERSION = JSON.stringify(version)
		const result = await Bun.build({
			entrypoints: [...entries].map((entry) => join(dir, entry)),
			outdir,
			root: join(dir, 'src'),
			target: 'node',
			format: 'esm',
			packages: name === 'fold-cli' ? 'bundle' : 'external',
			external: name === 'fold-cli' ? ['@opentui/core', '@opentui/core/*'] : [],
			sourcemap: 'external',
			plugins: name === 'fold-cli' ? [solidTransformPlugin] : [],
			define,
		})
		if (!result.success) throw new AggregateError(result.logs, `Failed to build ${manifest.name}`)
	}
	const buildConfig = join(dir, 'tsconfig.release.json')
	const compilerOptions: Record<string, boolean | string> = {
		noEmit: false,
		declaration: true,
		emitDeclarationOnly: !effectAiProvider,
		outDir: './dist',
		rootDir: './src',
	}
	if (effectAiProvider) {
		compilerOptions.module = 'NodeNext'
		compilerOptions.moduleResolution = 'NodeNext'
		compilerOptions.rewriteRelativeImportExtensions = true
		compilerOptions.sourceMap = true
	}
	await Bun.write(
		buildConfig,
		`${JSON.stringify(
			{
				extends: './tsconfig.json',
				compilerOptions,
				include: ['src'],
				exclude: ['test', 'examples', 'scripts'],
			},
			null,
			2,
		)}\n`,
	)
	const declaration = Bun.spawn(['bunx', 'tsc', '-p', buildConfig], {
		cwd: root,
		stdout: quiet ? 'pipe' : 'inherit',
		stderr: quiet ? 'pipe' : 'inherit',
	})
	const [declarationOutput, declarationError, declarationExit] = await Promise.all([
		quiet ? new Response(declaration.stdout).text() : '',
		quiet ? new Response(declaration.stderr).text() : '',
		declaration.exited,
	])
	await rm(buildConfig, { force: true })
	if (declarationExit !== 0) {
		if (quiet) {
			process.stdout.write(declarationOutput)
			process.stderr.write(declarationError)
		}
		throw new Error(`Failed to emit declarations for ${manifest.name}`)
	}
	console.log(`built ${manifest.name}`)
}
