/**
 * Host-provided archive access instructions for post-compaction prompts. Core stays isomorphic: it
 * knows only how to ask for optional model-visible instructions for the current agent, while hosts
 * that own a durable log path (fold-agent's JSONL sessions) decide what, if anything, to render.
 */
import { Context, Effect } from 'effect'

import type { AgentId } from '../Ids'
import type { CompactionTrigger } from './CompactionService'

/** Input for building optional instructions appended after a rendered compaction summary. */
export type CompactionArchiveAccessInput = {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly trigger: CompactionTrigger
}

/** Optional host instructions for finding very specific archived session details after compaction. */
export type CompactionArchiveAccessService = {
	readonly instructions: (input: CompactionArchiveAccessInput) => Effect.Effect<string | null>
}

/** The default host policy: do not add any archive access instructions. */
export const noopCompactionArchiveAccess: CompactionArchiveAccessService = {
	instructions: Effect.fn('fold.compaction_archive_access.instructions')(() => Effect.succeed(null)),
}

/**
 * Reference service used by the agent loop when appending a `compaction` row. Platform hosts may
 * provide a live implementation; tests and non-filesystem hosts get the no-op by default.
 */
export const CompactionArchiveAccess = Context.Reference<CompactionArchiveAccessService>(
	'fold/CompactionArchiveAccess',
	{
		defaultValue: () => noopCompactionArchiveAccess,
	},
)
