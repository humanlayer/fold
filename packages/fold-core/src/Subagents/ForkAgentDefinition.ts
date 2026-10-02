import { Schema } from 'effect'

import { toolsNeedingAll, type FoldTool, type FoldToolServices } from '../Api/ToolDefinition'

/** Stable identifier persisted on forks so their host-configured tools survive replay. */
export const ForkAgentDefinitionId = Schema.NonEmptyString.annotate({ identifier: 'ForkAgentDefinitionId' })
export type ForkAgentDefinitionId = typeof ForkAgentDefinitionId.Type

/** Host-owned tool configuration for one fork generation. Other agent configuration remains inherited. */
export type ForkAgentDefinition<R = never> = {
	readonly id: ForkAgentDefinitionId
	readonly tools: ReadonlyArray<FoldTool<R>>
}

/** Define the tools inherited by a configured fork; it needs the union of their services. */
export const defineForkAgent = <T extends FoldTool<unknown>>(definition: {
	readonly id: ForkAgentDefinitionId
	readonly tools: ReadonlyArray<T>
}): ForkAgentDefinition<FoldToolServices<T>> => ({ id: definition.id, tools: toolsNeedingAll(definition.tools) })
