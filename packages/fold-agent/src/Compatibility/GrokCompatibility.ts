import type { FoldSkills } from '@humanlayer/fold-core'
import { Effect, type FileSystem, type Path, Struct } from 'effect'

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
	const { configuredPluginPaths = [] } = options
	const plugins = yield* discoverGrokPluginSkillRoots({
		...Struct.pick(options, ['cwd', 'home', 'grokHome', 'projectRoot']),
		configuredPaths: configuredPluginPaths,
	})
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
