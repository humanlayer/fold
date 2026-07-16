import { parseArgs } from 'node:util'

const values = parseArgs({
	options: {
		version: { type: 'string' },
		tag: { type: 'string' },
	},
	allowPositionals: true,
}).values
const gitTag = process.env.GITHUB_REF_NAME ?? process.argv[2]
const version = values.version ?? (gitTag?.startsWith('v') ? gitTag.slice(1) : undefined)
if (!version?.match(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/))
	throw new Error(`Invalid release version: ${version ?? gitTag}`)
const prerelease = version.split('-')[1]
const distTag = values.tag ?? (prerelease ? prerelease.split('.')[0] : 'latest')
if (!distTag.match(/^[a-zA-Z][0-9a-zA-Z._-]*$/)) throw new Error(`Invalid npm tag: ${distTag}`)
console.log(`version=${version}`)
console.log(`tag=${distTag}`)
if (process.env.GITHUB_OUTPUT) await Bun.write(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${distTag}\n`)
