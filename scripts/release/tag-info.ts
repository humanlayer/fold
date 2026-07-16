export {}

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2]
if (!tag?.match(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/))
	throw new Error(`Invalid release tag: ${tag}`)
const version = tag.slice(1)
const prerelease = version.split('-')[1]
const distTag = prerelease ? prerelease.split('.')[0] : 'latest'
console.log(`version=${version}`)
console.log(`tag=${distTag}`)
if (process.env.GITHUB_OUTPUT) await Bun.write(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${distTag}\n`)
