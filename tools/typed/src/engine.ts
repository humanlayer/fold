import path from 'node:path'

import fg from 'fast-glob'
import * as ts from 'typescript-compiler'

import type { ResolvedConfig } from './config.js'
import { typedRules, workspaceRules } from './registry.js'
import type { RuleDiagnostic } from './rule.js'

export type RunResult = {
	diagnostics: readonly RuleDiagnostic[]
	errorCount: number
	projectPaths: readonly string[]
	warningCount: number
}

const toPosixPath = (value: string) => value.split(path.sep).join('/')

const normalizeDiagnostic = ({
	diagnostic,
	rootDir,
}: {
	diagnostic: RuleDiagnostic
	rootDir: string
}): RuleDiagnostic => {
	const absolute = path.isAbsolute(diagnostic.fileName)
		? diagnostic.fileName
		: path.resolve(rootDir, diagnostic.fileName)

	return {
		...diagnostic,
		fileName: toPosixPath(path.relative(rootDir, absolute)),
	}
}

export const formatDiagnostic = (diagnostic: RuleDiagnostic): string =>
	`${diagnostic.fileName}:${diagnostic.line}:${diagnostic.column} ${
		diagnostic.severity ?? 'error'
	} ${diagnostic.ruleName} ${diagnostic.message}`

export const discoverProjects = ({ config }: { config: ResolvedConfig }): readonly string[] =>
	fg
		.sync([...config.projects], {
			absolute: true,
			cwd: config.rootDir,
			dot: true,
			followSymbolicLinks: false,
			ignore: [...config.projectExcludes],
			onlyFiles: true,
			unique: true,
		})
		.sort((left, right) => left.localeCompare(right))

const loadProject = (projectPath: string) => {
	const read = ts.readConfigFile(projectPath, ts.sys.readFile)

	if (read.error !== undefined) {
		throw new Error(`${projectPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`)
	}

	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(projectPath), undefined, projectPath)

	if (parsed.errors.length > 0) {
		throw new Error(
			parsed.errors
				.map((error) => `${projectPath}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
				.join('\n'),
		)
	}

	return ts.createProgram({
		options: parsed.options,
		projectReferences: parsed.projectReferences,
		rootNames: parsed.fileNames,
	})
}

const createSourceExclusionMatcher = (config: ResolvedConfig) => {
	const excluded = new Set(
		fg.sync([...config.sourceExcludes], {
			cwd: config.rootDir,
			dot: true,
			followSymbolicLinks: false,
			onlyFiles: false,
		}),
	)

	return (fileName: string) => {
		const relative = toPosixPath(path.relative(config.rootDir, fileName))

		return relative.startsWith('../') || path.isAbsolute(relative) || excluded.has(relative)
	}
}

export const runTypedLint = ({ config }: { config: ResolvedConfig }): RunResult => {
	const diagnostics: RuleDiagnostic[] = []
	const report = ({
		diagnostic,
		ruleName,
	}: {
		diagnostic: Omit<RuleDiagnostic, 'ruleName' | 'severity'>
		ruleName: keyof typeof typedRules | keyof typeof workspaceRules
	}) => {
		const setting = config.rules[ruleName]

		if (setting.severity === 'off') {
			return
		}

		diagnostics.push(
			normalizeDiagnostic({
				diagnostic: {
					...diagnostic,
					ruleName,
					severity: setting.severity,
				},
				rootDir: config.rootDir,
			}),
		)
	}

	for (const [ruleName, rule] of Object.entries(workspaceRules)) {
		const name = ruleName as keyof typeof workspaceRules
		const setting = config.rules[name]

		if (setting.severity === 'off') {
			continue
		}

		rule.check({
			options: setting.options,
			report: (diagnostic) => report({ diagnostic, ruleName: name }),
			rootDir: config.rootDir,
		})
	}

	const projectPaths = discoverProjects({ config })
	const isExcluded = createSourceExclusionMatcher(config)

	for (const projectPath of projectPaths) {
		const program = loadProject(projectPath)
		const checker = program.getTypeChecker()

		for (const sourceFile of program.getSourceFiles()) {
			if (isExcluded(sourceFile.fileName)) {
				continue
			}

			for (const [ruleName, rule] of Object.entries(typedRules)) {
				const name = ruleName as keyof typeof typedRules
				const setting = config.rules[name]

				if (setting.severity === 'off') {
					continue
				}

				rule.check({
					checker,
					options: setting.options,
					report: (diagnostic) => report({ diagnostic, ruleName: name }),
					sourceFile,
				})
			}
		}
	}

	const unique = new Map<string, RuleDiagnostic>()

	for (const diagnostic of diagnostics) {
		const key = [
			diagnostic.fileName,
			diagnostic.line,
			diagnostic.column,
			diagnostic.ruleName,
			diagnostic.message,
			diagnostic.severity,
		].join('\0')
		unique.set(key, diagnostic)
	}

	const sorted = [...unique.values()].toSorted((left, right) =>
		formatDiagnostic(left).localeCompare(formatDiagnostic(right)),
	)

	return {
		diagnostics: sorted,
		errorCount: sorted.filter((item) => item.severity === 'error').length,
		projectPaths: projectPaths.map((item) => toPosixPath(path.relative(config.rootDir, item))),
		warningCount: sorted.filter((item) => item.severity === 'warn').length,
	}
}
