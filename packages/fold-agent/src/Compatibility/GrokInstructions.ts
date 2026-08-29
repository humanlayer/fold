import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { Effect, FileSystem, Schema } from 'effect'

export const GrokInstructionSource = Schema.Struct({
	path: Schema.String,
	content: Schema.String,
	scope: Schema.Literals(['global', 'ancestor']),
})
export type GrokInstructionSource = typeof GrokInstructionSource.Type

export type GrokInstructionOptions = {
	readonly cwd: string
	readonly home?: string
	readonly grokHome?: string
	readonly projectRoot?: string
}

const instructionNames = [
	'Agents.md',
	'Claude.md',
	'CLAUDE.md',
	'CLAUDE.local.md',
	'AGENT.md',
	'AGENTS.md',
	'.claude/CLAUDE.md',
	'.claude/CLAUDE.local.md',
] as const

const projectRuleDirectories = ['.grok/rules', '.claude/rules', '.cursor/rules'] as const

const isAncestor = (ancestor: string, path: string): boolean => {
	let current = path
	while (true) {
		if (current === ancestor) return true
		const parent = dirname(current)
		if (parent === current) return false
		current = parent
	}
}

const directoriesToBoundary = (cwd: string, boundary: string | null): ReadonlyArray<string> => {
	const directories: Array<string> = []
	let current = cwd
	while (true) {
		directories.push(current)
		if (current === boundary) break
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	return directories.reverse()
}

const stripRuleFrontmatter = (content: string): string => {
	const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
	if (!normalized.startsWith('---\n')) return normalized
	const end = normalized.indexOf('\n---', 4)
	return end < 0 ? normalized : normalized.slice(end + 4).trimStart()
}

const globPattern = (pattern: string): RegExp => {
	const escaped = pattern
		.split('')
		.map((character) => {
			if (character === '*') return '.*'
			if (character === '?') return '.'
			return /[\\^$+.()|{}[\]]/.test(character) ? `\\${character}` : character
		})
		.join('')
	return new RegExp(`(^|/)${escaped}${pattern.endsWith('/') ? '' : '($|/)'}`)
}

const makeGitIgnorePredicate = (contents: string): ((path: string) => boolean) => {
	const rules = contents
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('#'))
		.map((line) => ({
			negated: line.startsWith('!'),
			pattern: globPattern(line.replace(/^!\/?/, '').replace(/^\//, '')),
		}))
	return (path) => {
		let ignored = false
		for (const rule of rules) if (rule.pattern.test(path)) ignored = !rule.negated
		return ignored
	}
}

const readNonEmpty = (
	path: string,
	scope: 'global' | 'ancestor',
	isRule: boolean,
): Effect.Effect<GrokInstructionSource | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.readFileString(path).pipe(
			Effect.map((raw) => {
				const content = isRule ? stripRuleFrontmatter(raw) : raw
				return content.trim().length === 0 ? null : { path, content, scope }
			}),
			Effect.orElseSucceed(() => null),
		)
	})

const markdownRules = (directory: string): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.readDirectory(directory).pipe(
			Effect.map((entries) =>
				entries
					.filter((entry) => entry.toLowerCase().endsWith('.md'))
					.sort()
					.map((entry) => join(directory, entry)),
			),
			Effect.orElseSucceed(() => []),
		)
	})

export const loadGrokInstructions = Effect.fn('fold.grok_compatibility.load_instructions')(function* (
	options: GrokInstructionOptions,
) {
	const fs = yield* FileSystem.FileSystem
	const cwd = resolve(options.cwd)
	const homeValue = options.home === undefined ? homedir() : options.home
	const home = homeValue.length === 0 ? null : resolve(homeValue)
	const grokHome = resolve(options.grokHome ?? join(home ?? homedir(), '.grok'))
	const explicitRoot = options.projectRoot === undefined ? null : resolve(options.projectRoot)
	const boundary =
		explicitRoot !== null && isAncestor(explicitRoot, cwd)
			? explicitRoot
			: home !== null && isAncestor(home, cwd)
				? home
				: null
	const directories = directoriesToBoundary(cwd, boundary)
	const ignoreRoot = explicitRoot !== null && isAncestor(explicitRoot, cwd) ? explicitRoot : directories[0]
	const gitignore =
		ignoreRoot === undefined
			? ''
			: yield* fs.readFileString(join(ignoreRoot, '.gitignore')).pipe(Effect.orElseSucceed(() => ''))
	const isIgnored = makeGitIgnorePredicate(gitignore)
	const sources: Array<GrokInstructionSource> = []
	const seen = new Set<string>()

	const add = (source: GrokInstructionSource | null, projectRoot?: string) => {
		if (source === null || seen.has(source.path)) return
		if (projectRoot !== undefined) {
			const projectPath = relative(projectRoot, source.path).split(sep).join('/')
			if (isIgnored(projectPath)) return
		}
		seen.add(source.path)
		sources.push(source)
	}

	for (const name of instructionNames) add(yield* readNonEmpty(join(grokHome, name), 'global', false))
	for (const path of yield* markdownRules(join(grokHome, 'rules'))) add(yield* readNonEmpty(path, 'global', true))
	if (home !== null) {
		for (const vendor of ['.claude', '.cursor']) {
			for (const name of instructionNames) add(yield* readNonEmpty(join(home, vendor, name), 'global', false))
			for (const path of yield* markdownRules(join(home, vendor, 'rules')))
				add(yield* readNonEmpty(path, 'global', true))
		}
	}

	for (const directory of directories) {
		for (const name of instructionNames)
			add(yield* readNonEmpty(join(directory, name), 'ancestor', false), ignoreRoot)
		for (const rulesDirectory of projectRuleDirectories)
			for (const path of yield* markdownRules(join(directory, rulesDirectory)))
				add(yield* readNonEmpty(path, 'ancestor', true), ignoreRoot)
	}

	return sources
})

const escapeXmlAttribute = (text: string): string =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')

export const renderGrokInstructions = (sources: ReadonlyArray<GrokInstructionSource>): string | null => {
	if (sources.length === 0) return null
	return `<project_context>\n${sources
		.map(
			(source) =>
				`<project_instructions path="${escapeXmlAttribute(source.path)}">\n${source.content.trim()}\n</project_instructions>`,
		)
		.join('\n')}\n</project_context>`
}
