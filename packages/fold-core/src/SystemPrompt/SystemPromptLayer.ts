/**
 * This file implements the default SystemPrompt layer - family-keyed base prompt selection plus the
 * agent's own blocks (D17). fold-core ships no baked base prompts yet, so the default layer composes
 * the agent blocks unchanged; presets and hosts inject family base prompts through `makeSystemPrompt`.
 */
import { Effect, Layer } from 'effect'

import { modelFamilyFor, type ModelFamily } from '../Model/ModelFamily'
import { SystemPrompt, type ComposeSystemPromptInput } from './SystemPromptService'

/** Options for the default SystemPrompt implementation. */
export type MakeSystemPromptOptions = {
	/** Family-keyed base prompts, rendered as the first block when the active model's family has one. */
	readonly basePrompts?: Partial<Record<ModelFamily, string>>
}

/** Build a SystemPrompt layer selecting a family base prompt and appending the agent's blocks. */
export const makeSystemPrompt = (options?: MakeSystemPromptOptions): Layer.Layer<SystemPrompt> =>
	Layer.succeed(SystemPrompt, {
		compose: Effect.fn('fold.system_prompt.compose')((input: ComposeSystemPromptInput) =>
			Effect.sync(() => {
				const base = options?.basePrompts?.[modelFamilyFor(input.model)]

				return base === undefined ? input.agentBlocks : [base, ...input.agentBlocks]
			}),
		),
	})

/** Default SystemPrompt layer: no family base prompts, agent blocks pass through unchanged. */
export const layerDefaultSystemPrompt: Layer.Layer<SystemPrompt> = makeSystemPrompt()
