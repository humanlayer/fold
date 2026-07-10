/**
 * This file defines the Compaction service contract (D11): the opt-in seam through which the agent
 * loop asks whether an agent's context should compact and, when it should, produces the durable
 * `compaction` entry payload (summary, cut, tokens). The service is a `Context.Reference` whose
 * default is the disabled no-op - compaction is off unless a session provides a live service - so
 * the loop consults it unconditionally with zero configuration burden on low-level composition
 * roots (core owns loop semantics; hosts own enablement - the D11 package-boundary ruling).
 *
 * The service deliberately does NOT append log entries or hold a summarizer model: the loop owns
 * envelopes and appends, and `plan` takes `LanguageModel` in its requirements so each agent
 * summarizes through its own provisioned model by default (subagents compact with their own model -
 * D21) while a future tart-agent layer can ignore the ambient model and bring a configured fast
 * summarizer instead.
 */
import { Context, Effect, Schema } from 'effect'
import type { LanguageModel } from 'effect/unstable/ai'

import type { ActiveModel, LogEntry, LogSeq } from '../EventLog/Schemas'
import type { AgentId } from '../Ids'

/**
 * Auto-compaction configuration on an agent definition. Omitted (`undefined`) means disabled - the
 * D11 disabled-by-default ruling. One config applies to the whole session: the root agent and every
 * subagent compact under the same policy, each against its own projection and its own model's
 * context window.
 */
export type AutoCompactConfig =
	| { readonly enabled: false }
	| {
			readonly enabled: true
			/**
			 * Replaces the default summarization instruction (pi's structured checkpoint template) for
			 * initial and incremental compactions alike. The serialized `<conversation>` transcript and
			 * incremental `<previous-summary>` block are always provided above the instruction.
			 */
			readonly compactionPrompt?: string
			/** Override the context-usage threshold that triggers compaction. */
			readonly thresholdTokens?: number
			/** Override the model's context window in tokens; defaults to the interim per-model table (D15). */
			readonly contextWindow?: number
			/** Tokens reserved below the usable budget so compaction fires early (default 16384, pi). */
			readonly reserveTokens?: number
			/** Recent-message tail kept verbatim out of the summary (default 20000, pi). */
			readonly keepRecentTokens?: number
	  }

/** Why a compaction ran: proactive threshold, provider overflow recovery, or explicit user command. */
export type CompactionTrigger = 'threshold' | 'overflow' | 'manual'

/** Input for the top-of-turn threshold check. */
export type CompactionCheckInput = {
	readonly agentId: AgentId
	/** Full session log snapshot; the service projects the agent's visible slice itself. */
	readonly entries: ReadonlyArray<LogEntry>
	/** The agent's active model, whose context window bounds the check. */
	readonly model: ActiveModel | null
}

/** Input for building one compaction: the check input plus what caused it. */
export type CompactionPlanInput = CompactionCheckInput & {
	readonly trigger: CompactionTrigger
}

/** The payload of one durable `compaction` entry, ready for the loop to append. */
export type CompactionPlan = {
	readonly summary: string
	/** Projection drops visible message entries at or below this sequence (D2). */
	readonly replacesThroughSeq: LogSeq
	/** The context size that triggered the compaction, from the last API-reported usage. */
	readonly tokensBefore: number
}

/** The summarization call failed; the loop records a durable error note and continues uncompacted. */
export class CompactionSummarizeError extends Schema.TaggedErrorClass<CompactionSummarizeError>()(
	'CompactionSummarizeError',
	{
		message: Schema.String,
	},
) {}

/**
 * Compaction operations consulted by the agent loop each turn.
 *
 * `shouldCompact` is the cheap proactive gate: it compares the agent's last post-compaction
 * API-reported usage against the model's usable budget and never calls a model. `plan` does the
 * work - chooses the cut, serializes the replaced history, runs the summarization call through the
 * ambient LanguageModel, and returns the entry payload - or `null` when there is nothing safely
 * summarizable (the loop then proceeds uncompacted).
 */
export type CompactionService = {
	/** Whether a live compaction policy is installed; gates the reactive overflow path. */
	readonly enabled: boolean
	readonly shouldCompact: (input: CompactionCheckInput) => Effect.Effect<boolean>
	readonly plan: (
		input: CompactionPlanInput,
	) => Effect.Effect<CompactionPlan | null, CompactionSummarizeError, LanguageModel.LanguageModel>
}

/** The disabled default: never compacts, and `plan` is unreachable (the loop gates on the checks). */
export const noopCompaction: CompactionService = {
	enabled: false,
	shouldCompact: () => Effect.succeed(false),
	plan: () => Effect.die(new Error('compaction is disabled: the no-op Compaction service cannot plan a compaction')),
}

/**
 * Compaction service key with the no-op default (D11: optional, disabled by default). Sessions
 * started with `autoCompact: { enabled: true, ... }` provide the live service; everything else -
 * including low-level layer graphs that never mention compaction - resolves the no-op.
 */
export const Compaction: Context.Reference<CompactionService> = Context.Reference('tart/Compaction', {
	defaultValue: () => noopCompaction,
})
