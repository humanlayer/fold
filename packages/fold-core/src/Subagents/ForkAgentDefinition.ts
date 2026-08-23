import { Schema } from 'effect'

import type { FoldTool } from '../Api/ToolDefinition'

/** Stable identifier persisted on forks so their host-configured tools survive replay. */
export const ForkAgentDefinitionId = Schema.NonEmptyString.annotate({ identifier: 'ForkAgentDefinitionId' })
export type ForkAgentDefinitionId = typeof ForkAgentDefinitionId.Type

/** Host-owned tool configuration for one fork generation. Other agent configuration remains inherited. */
export type ForkAgentDefinition = {
	readonly id: ForkAgentDefinitionId
	readonly tools: ReadonlyArray<FoldTool>
}

/** Define the tools inherited by a configured fork. */
export const defineForkAgent = (definition: ForkAgentDefinition): ForkAgentDefinition => definition
