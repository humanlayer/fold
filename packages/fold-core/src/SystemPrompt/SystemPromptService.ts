/**
 * This file defines the SystemPrompt service contract - per-epoch composition of the leading system
 * prompt block set (D17). AgentRuntime calls `compose` once per epoch (agent start; later, model
 * change) with the agent's own blocks; the implementation selects the per-family base prompt and
 * assembles the ordered block set. Environment, memory-file, and skills blocks compose behind this
 * same seam as those services land (D17/D20/D22).
 */
import { Context } from 'effect'
import type { Effect } from 'effect'

import type { ActiveModel } from '../EventLog/Schemas'

/** Input for composing one epoch's leading system prompt block set. */
export type ComposeSystemPromptInput = {
	readonly model: ActiveModel
	/** The agent's own prompt blocks, appended after any family base prompt. */
	readonly agentBlocks: ReadonlyArray<string>
}

/** Per-epoch system prompt composition. An empty result means no leading system message is written. */
export type SystemPromptService = {
	readonly compose: (input: ComposeSystemPromptInput) => Effect.Effect<ReadonlyArray<string>>
}

/** SystemPrompt service tag. Swappable wholesale by presets and hosts (D17). */
export class SystemPrompt extends Context.Service<SystemPrompt, SystemPromptService>()('fold/SystemPrompt') {}
