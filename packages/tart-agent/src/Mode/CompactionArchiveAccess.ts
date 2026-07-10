import { shortAgentId, type AgentId, type CompactionArchiveAccessService } from '@humanlayer/tart-core'
/**
 * tart-agent's host implementation of post-compaction archive access instructions. Core persists and
 * renders the returned string, but only tart-agent knows the JSONL session path and whether the root is
 * running in RLM mode without direct bash access.
 */
import { Effect } from 'effect'

/** Inputs for formatting the model-visible post-compaction archive guidance. */
export type FormatCompactionArchiveInstructionsInput = {
	readonly logPath: string
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly modeName: string
}

/** Options for the tart-agent archive-access service. */
export type CompactionArchiveAccessOptions = {
	readonly logPath: string
	readonly modeName: string
}

const logShapeCheatSheet = `Log shape cheat sheet:
- This is JSONL: one dense JSON event per physical line, ordered by seq.
- Top-level fields: _tag, seq, ts, agentId, parentAgentId, toolCallId.
- session_started: sessionId, cwd, rootAgentId, meta.agentName.
- agent_started: agentType, model, tools, skill, mode, fork.fromAgentId, fork.atSeq.
- system-message: messages[].content and placement; this is where leading prompts live.
- user-message: message.content is the user/steering/follow-up text the agent saw.
- assistant-message: message.content may contain text, reasoning, and tool-call parts; tool calls have name and params.
- tool-result: message.content[].result holds tool output; bash uses result.output, read uses result.content[].text, failures use isFailure and result.message.
- compaction: summary, replacesThroughSeq, tokensBefore, and any postCompactionInstructions.
- error: errorType, message, details.
- agent-finished: outcome, resultText, reason.`

const caution = `This log is very dense. Do not read it wholesale. Treat it as last-resort archival memory only when the current summary and recent context are missing a very specific detail. Search narrowly for exact file paths, error snippets, tool names, message ids, or user wording, then inspect only the matching JSONL lines.`

const directInstructions = (input: FormatCompactionArchiveInstructionsInput): string => `<session-log-access>
The full pre-compaction session log is available at:
${input.logPath}

Your current agent id is:
${input.agentId}

Your short agent id prefix is:
${shortAgentId(input.agentId)}

${caution}

When searching, include your agent id so you only inspect your own prior context. Prefer a two-stage fixed-string search:

rg -n -F '"agentId":"${input.agentId}"' "${input.logPath}" | rg -F 'EXACT_TERM'

If you are searching by a short agent id prefix, omit the trailing quote because the persisted value is the full id:

rg -n -F '"agentId":"${shortAgentId(input.agentId)}' "${input.logPath}" | rg -F 'EXACT_TERM'

${logShapeCheatSheet}
</session-log-access>`

const rlmRootInstructions = (input: FormatCompactionArchiveInstructionsInput): string => `<session-log-access>
The full pre-compaction session log is available at:
${input.logPath}

Your current orchestrator agent id is:
${input.agentId}

Your short orchestrator id prefix is:
${shortAgentId(input.agentId)}

${caution}

You are in RLM/orchestrator mode and do not have bash. If you need archived context, delegate a narrow search to the bash subagent.

For your own prior context, ask the bash subagent to search for lines containing both your full agent id and the exact term you need:

rg -n -F '"agentId":"${input.agentId}"' "${input.logPath}" | rg -F 'EXACT_TERM'

For a subagent's internal context, use that subagent's agent_id from a previous subagent result, such as agent_abcd1234. That id is a prefix of the full persisted agentId, so ask the bash subagent to search without a trailing quote:

rg -n -F '"agentId":"agent_abcd1234' "${input.logPath}" | rg -F 'EXACT_TERM'

If the subagent was forked, inherited context may be referenced by agent_started.fork.fromAgentId and fork.atSeq rather than copied into the subagent's own rows.

${logShapeCheatSheet}
</session-log-access>`

/** Format the post-compaction archive access block for one agent. */
export const formatCompactionArchiveInstructions = (input: FormatCompactionArchiveInstructionsInput): string =>
	input.modeName === 'rlm' && input.parentAgentId === null ? rlmRootInstructions(input) : directInstructions(input)

/** Build tart-agent's live CompactionArchiveAccess service for one JSONL-backed session. */
export const compactionArchiveAccessFor = (
	options: CompactionArchiveAccessOptions,
): CompactionArchiveAccessService => ({
	instructions: Effect.fn('tart_agent.compaction_archive_access.instructions')((input) =>
		Effect.succeed(
			formatCompactionArchiveInstructions({
				logPath: options.logPath,
				modeName: options.modeName,
				agentId: input.agentId,
				parentAgentId: input.parentAgentId,
			}),
		),
	),
})
