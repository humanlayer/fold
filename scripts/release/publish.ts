import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { libraries, stage, targetName, targets } from './manifest'

const values = parseArgs({
	options: {
		version: { type: 'string' },
		tag: { type: 'string', default: 'latest' },
		'dry-run': { type: 'boolean', default: false },
		skip: { type: 'string', multiple: true, default: [] },
	},
}).values
if (!values.version) throw new Error('--version is required')
const skippedPackages = new Set(
	values.skip
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter(Boolean),
)
const dirs = [
	...libraries.map((name) => join(stage, 'packages', name)),
	...targets.map((target) => join(stage, 'native', targetName(target).replace('@humanlayer/', ''))),
	join(stage, 'packages/fold'),
]
const publishablePackages = new Set([
	...libraries.map((name) => `@humanlayer/${name}`),
	...targets.map(targetName),
	'@humanlayer/fold',
])
for (const name of skippedPackages)
	if (!publishablePackages.has(name)) throw new Error(`Cannot skip unknown package: ${name}`)

async function alreadyPublished(name: string, version: string) {
	const child = Bun.spawn(['npm', 'view', `${name}@${version}`, 'version', '--json'], {
		stdout: 'pipe',
		stderr: 'ignore',
	})
	const output = await new Response(child.stdout).text()
	return (await child.exited) === 0 && output.trim().length > 0
}

for (const dir of dirs) {
	const manifest: { name: string; version: string } = await Bun.file(join(dir, 'package.json')).json()
	if (manifest.version !== values.version)
		throw new Error(`${manifest.name} is staged at ${manifest.version}, expected ${values.version}`)
	if (skippedPackages.has(manifest.name)) {
		console.log(`skipping ${manifest.name}@${manifest.version}: explicitly requested`)
		continue
	}
	if (!values['dry-run'] && (await alreadyPublished(manifest.name, manifest.version))) {
		console.log(`skipping ${manifest.name}@${manifest.version}: already published`)
		continue
	}
	const command = [
		'npm',
		'publish',
		'--access',
		'public',
		'--tag',
		values.tag ?? 'latest',
		...(values['dry-run'] ? ['--dry-run'] : []),
	]
	console.log(`${values['dry-run'] ? 'dry-run' : 'publishing'} ${dir}`)
	const child = Bun.spawn(command, {
		cwd: dir,
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
		env: process.env,
	})
	if ((await child.exited) !== 0) throw new Error(`Publish failed for ${dir}`)
}
