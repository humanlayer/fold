import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { SkillSourceService } from '@humanlayer/fold-core'
import { Effect, type FileSystem } from 'effect'

import { loadCodexInstructions, renderCodexInstructions, type CodexInstructionSource } from './CodexInstructions'
import { discoverCodexPluginSkillRoots, type CodexPluginDiagnostic } from './CodexPlugins'
import { makeCodexSkillSource, type CodexSkillOptions } from './CodexSkills'

export type CodexCompatibilityOptions = CodexSkillOptions & {
	readonly fileSystem?: FileSystem.FileSystem
}

export type CodexCompatibility = {
	readonly instructions: ReadonlyArray<CodexInstructionSource>
	readonly instructionBlock: string | null
	readonly skills: SkillSourceService
	readonly diagnostics: ReadonlyArray<CodexPluginDiagnostic>
}

export const loadCodexCompatibility = (options: CodexCompatibilityOptions) =>
	Effect.gen(function* () {
		const homeValue = options.home === undefined ? homedir() : options.home
		const codexHome = resolve(options.codexHome ?? join(homeValue, '.codex'))
		const plugins = yield* discoverCodexPluginSkillRoots(
			options.fileSystem === undefined ? { codexHome } : { codexHome, fileSystem: options.fileSystem },
		)
		const instructions = yield* loadCodexInstructions(options)
		const skills = yield* makeCodexSkillSource({
			...options,
			pluginPaths: [...(options.pluginPaths ?? []), ...plugins.roots],
		})
		return {
			instructions,
			instructionBlock: renderCodexInstructions(instructions),
			skills,
			diagnostics: plugins.diagnostics,
		}
	})
