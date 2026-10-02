import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { RuleName } from './registry.js'
import type { Severity } from './rule.js'

export type RuleSetting = Severity | readonly [Exclude<Severity, 'off'>, Readonly<Record<string, unknown>>]

export type TypedLintConfig = {
	projectExcludes?: readonly string[]
	projects?: readonly string[]
	rules?: Partial<Record<RuleName, RuleSetting>>
	sourceExcludes?: readonly string[]
}

export type ResolvedRuleSetting = {
	options: Readonly<Record<string, unknown>>
	severity: Severity
}

export type ResolvedConfig = {
	configPath?: string
	projectExcludes: readonly string[]
	projects: readonly string[]
	rootDir: string
	rules: Readonly<Record<RuleName, ResolvedRuleSetting>>
	sourceExcludes: readonly string[]
}

const configNames = [
	'typed-lint.config.mjs',
	'typed-lint.config.js',
	'typed-lint.config.cjs',
	'typed-lint.config.ts',
	'typed-lint.config.json',
] as const

const defaultProjectExcludes = [
	'**/node_modules/**',
	'**/dist/**',
	'**/build/**',
	'**/coverage/**',
	'**/.git/**',
] as const

const defaultSourceExcludes = [
	'**/*.d.ts',
	'**/node_modules/**',
	'**/dist/**',
	'**/build/**',
	'**/coverage/**',
] as const

const knownRules = new Set<RuleName>([
	'no-svg-files',
	'no-xstate-derived-boolean-context',
	'prefer-effect-array-match',
	'prefer-typed-schema-apis',
])

const defaultRules: Readonly<Record<RuleName, ResolvedRuleSetting>> = {
	'no-svg-files': { options: {}, severity: 'error' },
	'no-xstate-derived-boolean-context': { options: {}, severity: 'error' },
	'prefer-effect-array-match': { options: {}, severity: 'error' },
	'prefer-typed-schema-apis': { options: {}, severity: 'error' },
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const validateStringArray = ({ name, value }: { name: string; value: unknown }): readonly string[] | undefined => {
	if (value === undefined) {
		return undefined
	}

	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
		throw new Error(`Configuration "${name}" must be an array of strings.`)
	}

	return value
}

const validateSeverity = ({ name, value }: { name: string; value: unknown }): Severity => {
	if (value !== 'error' && value !== 'warn' && value !== 'off') {
		throw new Error(`Rule "${name}" severity must be "error", "warn", or "off".`)
	}

	return value
}

const resolveRules = (value: unknown): Readonly<Record<RuleName, ResolvedRuleSetting>> => {
	if (value !== undefined && !isRecord(value)) {
		throw new Error('Configuration "rules" must be an object.')
	}

	const result = { ...defaultRules }

	for (const [name, setting] of Object.entries(value ?? {})) {
		if (!knownRules.has(name as RuleName)) {
			throw new Error(`Unknown typed-lint rule "${name}".`)
		}

		if (Array.isArray(setting)) {
			if (setting.length !== 2 || !isRecord(setting[1])) {
				throw new Error(`Rule "${name}" tuple must contain a severity and options object.`)
			}

			result[name as RuleName] = {
				options: setting[1],
				severity: validateSeverity({ name, value: setting[0] }),
			}
			continue
		}

		result[name as RuleName] = {
			options: {},
			severity: validateSeverity({ name, value: setting }),
		}
	}

	return result
}

const validateConfig = (value: unknown): TypedLintConfig => {
	if (!isRecord(value)) {
		throw new Error('typed-lint configuration must export an object.')
	}

	const knownKeys = new Set(['projectExcludes', 'projects', 'rules', 'sourceExcludes'])

	for (const key of Object.keys(value)) {
		if (!knownKeys.has(key)) {
			throw new Error(`Unknown typed-lint configuration key "${key}".`)
		}
	}

	return {
		projectExcludes: validateStringArray({
			name: 'projectExcludes',
			value: value.projectExcludes,
		}),
		projects: validateStringArray({ name: 'projects', value: value.projects }),
		rules: value.rules as TypedLintConfig['rules'],
		sourceExcludes: validateStringArray({
			name: 'sourceExcludes',
			value: value.sourceExcludes,
		}),
	}
}

export const defineConfig = (config: TypedLintConfig): TypedLintConfig => config

export const findConfigPath = ({ rootDir }: { rootDir: string }): string | undefined => {
	for (const name of configNames) {
		const candidate = path.join(rootDir, name)

		if (fs.existsSync(candidate)) {
			return candidate
		}
	}

	return undefined
}

const importConfig = async (configPath: string): Promise<unknown> => {
	if (path.extname(configPath) === '.json') {
		return JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown
	}

	const cacheBuster = `${pathToFileURL(configPath).href}?mtime=${fs.statSync(configPath).mtimeMs}`
	const loaded = (await import(cacheBuster)) as { default?: unknown }

	return loaded.default
}

export const loadConfig = async ({
	configPath,
	rootDir,
}: {
	configPath?: string
	rootDir: string
}): Promise<ResolvedConfig> => {
	const absoluteRoot = path.resolve(rootDir)
	const selectedPath =
		configPath === undefined ? findConfigPath({ rootDir: absoluteRoot }) : path.resolve(absoluteRoot, configPath)

	if (selectedPath !== undefined && !fs.existsSync(selectedPath)) {
		throw new Error(`Configuration file not found: ${selectedPath}`)
	}

	const raw = selectedPath === undefined ? {} : validateConfig(await importConfig(selectedPath))
	const config = validateConfig(raw)

	return {
		configPath: selectedPath,
		projectExcludes: config.projectExcludes ?? defaultProjectExcludes,
		projects: config.projects ?? ['**/tsconfig.json'],
		rootDir: absoluteRoot,
		rules: resolveRules(config.rules),
		sourceExcludes: config.sourceExcludes ?? defaultSourceExcludes,
	}
}
