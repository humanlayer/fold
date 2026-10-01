import type { FoldSkills } from '@humanlayer/fold-core'
import { Effect, type FileSystem, type Path } from 'effect'

import { loadGrokInstructions, renderGrokInstructions, type GrokInstructionSource } from './GrokInstructions'
import { discoverGrokPluginSkillRoots, type GrokPluginDiagnostic } from './GrokPlugins'
import { grokSkills, type GrokSkillOptions } from './GrokSkills'

export type GrokCompatibilityOptions = GrokSkillOptions & {
	readonly configuredPluginPaths?: ReadonlyArray<string>
}

export type GrokCompatibility = {
	readonly instructions: ReadonlyArray<GrokInstructionSource>
	readonly instructionBlock: string | null
	readonly skills: FoldSkills<FileSystem.FileSystem | Path.Path>
	readonly diagnostics: ReadonlyArray<GrokPluginDiagnostic>
}

export const loadGrokCompatibility = Effect.fn('fold.grok_compatibility.load')(function* (
	options: GrokCompatibilityOptions,
) {
	const pluginOptions: {
		cwd: string
		home?: string
		grokHome?: string
		projectRoot?: string
		configuredPaths?: ReadonlyArray<string>
	} = {
		cwd: options.cwd,
	}
	if (options.home !== undefined) pluginOptions.home = options.home
	if (options.grokHome !== undefined) pluginOptions.grokHome = options.grokHome
	if (options.projectRoot !== undefined) pluginOptions.projectRoot = options.projectRoot
	if (options.configuredPluginPaths !== undefined) pluginOptions.configuredPaths = options.configuredPluginPaths
	const plugins = yield* discoverGrokPluginSkillRoots(pluginOptions)
	const instructions = yield* loadGrokInstructions(options)
	const { pluginPaths = [] } = options
	const skills = grokSkills({ ...options, pluginPaths: [...pluginPaths, ...plugins.roots] })
	return {
		instructions,
		instructionBlock: renderGrokInstructions(instructions),
		skills,
		diagnostics: plugins.diagnostics,
	}
})
