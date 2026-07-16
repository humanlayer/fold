import { existsSync, realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { createSolidTransformPlugin } from '../../packages/fold-cli/node_modules/@opentui/solid/scripts/solid-plugin'
import { json, root, targetName, targets } from '../release/manifest'

const args = new Set(process.argv.slice(2))
const versionArg = process.argv.find((_, index, all) => all[index - 1] === '--version') ?? '0.0.0'
const selected = args.has('--host')
	? targets.filter(
			([os, cpu, variant]) =>
				(os === 'windows' ? 'win32' : os) === process.platform && cpu === process.arch && variant === '',
		)
	: targets
const { workspaces } = await json<{ workspaces: { catalog: Record<string, string> } }>(join(root, 'package.json'))
const catalog = workspaces.catalog

if (!args.has('--skip-install')) {
	const install = Bun.spawn(
		[
			'bun',
			'install',
			'--no-save',
			'--ignore-scripts',
			'--os=*',
			'--cpu=*',
			`@opentui/core@${catalog['@opentui/core']}`,
		],
		{ cwd: root, stdout: 'inherit', stderr: 'inherit' },
	)
	if ((await install.exited) !== 0) throw new Error('Failed to install @opentui/core target variants')
}

await rm(join(root, 'dist'), { recursive: true, force: true })
const localWorker = join(root, 'packages/fold-cli/node_modules/@opentui/core/parser.worker.js')
const parserWorker = realpathSync(
	existsSync(localWorker) ? localWorker : join(root, 'node_modules/@opentui/core/parser.worker.js'),
)
const workerRelative = relative(root, parserWorker).replaceAll('\\', '/')

for (const target of selected) {
	const [os, cpu, variant] = target
	const packageName = targetName(target).replace('@humanlayer/', '')
	const outdir = join(root, 'dist', packageName, 'bin')
	await mkdir(outdir, { recursive: true })
	const bunTarget: Bun.CompileTarget = `bun-${os === 'windows' ? 'windows' : os}-${cpu}${variant.includes('baseline') ? '-baseline' : ''}${variant.includes('musl') ? '-musl' : ''}`
	const bunfs = os === 'windows' ? 'B:/~BUN/root/' : '/$bunfs/root/'
	const result = await Bun.build({
		entrypoints: [join(root, 'packages/fold-cli/src/cli.ts'), parserWorker],
		plugins: [createSolidTransformPlugin()],
		target: 'bun',
		format: 'esm',
		minify: true,
		define: {
			FOLD_VERSION: JSON.stringify(versionArg),
			OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(bunfs + workerRelative),
			...(os === 'linux'
				? { 'process.env.OPENTUI_LIBC': JSON.stringify(variant.includes('musl') ? 'musl' : 'glibc') }
				: {}),
		},
		compile: {
			target: bunTarget,
			outfile: join(outdir, os === 'windows' ? 'foldcode.exe' : 'foldcode'),
			autoloadBunfig: false,
			autoloadDotenv: false,
			execArgv: ['--use-system-ca', '--'],
			windows: {},
		},
	})
	if (!result.success) throw new AggregateError(result.logs, `Failed to build ${packageName}`)
	if ((os === 'windows' ? 'win32' : os) === process.platform && cpu === process.arch && variant === '') {
		const binary = join(outdir, os === 'windows' ? 'foldcode.exe' : 'foldcode')
		const smoke = Bun.spawn([binary, '--version'], { stdout: 'pipe', stderr: 'inherit' })
		const output = await new Response(smoke.stdout).text()
		if ((await smoke.exited) !== 0 || !output.includes(versionArg))
			throw new Error(`Binary smoke test failed: ${output.trim()}`)
		console.log(`smoke tested ${packageName}: ${output.trim()}`)
	}
}
