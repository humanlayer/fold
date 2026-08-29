import type { SkillSourceService } from '@humanlayer/fold-core'
import { Effect, type FileSystem } from 'effect'

import { loadGrokInstructions, renderGrokInstructions, type GrokInstructionSource } from './GrokInstructions'
import { discoverGrokPluginSkillRoots, type GrokPluginDiagnostic } from './GrokPlugins'
import { makeGrokSkillSource, type GrokSkillOptions } from './GrokSkills'

export type GrokCompatibilityOptions = GrokSkillOptions & {
	readonly fileSystem?: FileSystem.FileSystem
	readonly configuredPluginPaths?: ReadonlyArray<string>
}

export type GrokCompatibility = {
	readonly instructions: ReadonlyArray<GrokInstructionSource>
	readonly instructionBlock: string | null
	readonly skills: SkillSourceService
	readonly diagnostics: ReadonlyArray<GrokPluginDiagnostic>
}

export const loadGrokCompatibility = Effect.fn('fold.grok_compatibility.load')(function* (
	options: GrokCompatibilityOptions,
) {
	const pluginOptions = {
		cwd: options.cwd,
		...(options.home === undefined ? {} : { home: options.home }),
		...(options.grokHome === undefined ? {} : { grokHome: options.grokHome }),
		...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
		...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
		...(options.configuredPluginPaths === undefined ? {} : { configuredPaths: options.configuredPluginPaths }),
	}
	const plugins = yield* discoverGrokPluginSkillRoots(pluginOptions)
	const instructions = yield* loadGrokInstructions(options)
	const skills = yield* makeGrokSkillSource({
		...options,
		pluginPaths: [...(options.pluginPaths ?? []), ...plugins.roots],
	})
	return {
		instructions,
		instructionBlock: renderGrokInstructions(instructions),
		skills,
		diagnostics: plugins.diagnostics,
	}
})
