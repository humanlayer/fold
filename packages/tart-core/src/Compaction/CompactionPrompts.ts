/**
 * This file carries the compaction summary prompt contract (D11): the system prompt and instruction
 * templates the summarization call uses, ported verbatim from pi (`coding-agent/src/core/compaction`),
 * plus the assembly of the one user message the summarizer model receives. An agent's
 * `autoCompact.compactionPrompt` replaces the instruction template (initial and incremental alike);
 * the surrounding `<conversation>` / `<previous-summary>` framing is fixed so custom prompts keep the
 * same inputs.
 */

/** System prompt for every summarization call (pi's `SUMMARIZATION_SYSTEM_PROMPT`, verbatim). */
export const compactionSystemPrompt = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

/** Instruction for the first compaction of a conversation (pi's `SUMMARIZATION_PROMPT`, verbatim). */
export const defaultCompactionPrompt = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

/**
 * Instruction when a previous summary exists (pi's `UPDATE_SUMMARIZATION_PROMPT`, verbatim). The new
 * summary REPLACES the old one in projection, so it must carry everything forward itself.
 */
export const defaultCompactionUpdatePrompt = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

/** Inputs for assembling the summarizer's one user message. */
export type CompactionRequestTextInput = {
	/** The serialized transcript of the messages being replaced. */
	readonly conversationText: string
	/** The previous compaction's summary when this is an incremental compaction. */
	readonly previousSummary: string | null
	/** Replaces the default instruction template when the agent configured `compactionPrompt`. */
	readonly customPrompt: string | null
}

/**
 * Assemble the summarizer's user message (pi's `generateSummary` shape): the serialized conversation,
 * the previous summary when incremental, then the instruction template.
 */
export const buildCompactionRequestText = (input: CompactionRequestTextInput): string => {
	const instruction =
		input.customPrompt ?? (input.previousSummary === null ? defaultCompactionPrompt : defaultCompactionUpdatePrompt)

	const previousBlock =
		input.previousSummary === null ? '' : `<previous-summary>\n${input.previousSummary}\n</previous-summary>\n\n`

	return `<conversation>\n${input.conversationText}\n</conversation>\n\n${previousBlock}${instruction}`
}
