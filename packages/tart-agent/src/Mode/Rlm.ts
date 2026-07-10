/**
 * This file defines the RLM orchestrator mode (D21/D27): a root agent whose job is coherency, not
 * hands-on work. Its prompt ports agentlayer's rich orchestrator prompt, strengthened with an explicit
 * "you have no bash" rule, and its toolset is the standard file tools WITHOUT bash - the absence of
 * bash on the root is the whole point, so every command execution is forced through the `subagent`
 * tool's roster (general-purpose, researcher, web-search-researcher, bash - see Mode/Subagents).
 *
 * The mode runs on the `orchestrator` config role, which falls back to `smart` when the config
 * declares no orchestrator binding (D25).
 */
import { skillTool, subagentTool } from '@humanlayer/tart-core'

import { skillsFromDisk } from '../Skills/DiskSkills'
import { applyPatchTool } from '../Tools/ApplyPatchTool'
import { editTool } from '../Tools/EditTool'
import { readTool } from '../Tools/ReadTool'
import { writeTool } from '../Tools/WriteTool'
import type { TartMode } from './Mode'
import { modeSubagents } from './Rpi'

/** The RLM orchestrator system prompt (agentlayer's orchestrator prompt, ported and strengthened). */
export const RLM_ORCHESTRATOR_PROMPT: string =
	'# Sub-Agent Orchestration\n\n' +
	'You are an orchestrator agent. Your primary job is to maintain coherency across long-horizon, ' +
	'context-heavy tasks by delegating work to sub-agents.\n\n' +
	'## Core Principle\n\n' +
	'All non-trivial operations should be delegated to sub-agents. You should NOT attempt to do complex ' +
	'work directly - instead, break it down and dispatch it to the appropriate sub-agent with the ' +
	'`subagent` tool. Your roster: `general-purpose` (multi-step tasks end to end), `researcher` ' +
	'(locating and explaining code), `web-search-researcher` (current web research), and `bash` ' +
	'(running commands).\n\n' +
	'## Delegation Strategy\n\n' +
	'- Research and understanding: Delegate codebase exploration, file reading, pattern discovery, and ' +
	'context gathering to sub-agents.\n' +
	'- Command execution: You have NO bash tool. Delegate ALL command execution - builds, tests, git, ' +
	'scripts - to the `bash` or `general-purpose` sub-agents.\n' +
	'- Implementation: Delegate file edits, refactors, and code changes to sub-agents with clear, ' +
	'specific instructions. You retain read/write/edit tools for small direct file operations, but ' +
	'prefer delegating substantial implementation.\n\n' +
	'## Rules\n\n' +
	'1. Use separate sub-agents for separate tasks. Do not overload a single sub-agent with unrelated work.\n' +
	'2. You may launch sub-agents in parallel when their tasks are independent.\n' +
	'3. Do NOT delegate tasks with significant overlap to the same sub-agent - split them up.\n' +
	'4. Provide each sub-agent with clear, specific instructions including all relevant context it needs ' +
	'to succeed.\n' +
	'5. After sub-agents complete, synthesize their results and determine next steps.'

/**
 * The RLM orchestrator mode: file tools without bash, disk skills, and the default subagent roster.
 * The family policy still picks the right editing subset per model (write/edit vs apply_patch), so all
 * four file tools are installed; only bash is deliberately absent.
 */
export const rlmMode: TartMode = {
	name: 'rlm',
	role: 'orchestrator',
	systemPrompt: RLM_ORCHESTRATOR_PROMPT,
	// RLM always carries the RPI specialists (user ruling 2026-07-09): an orchestrator with no bash
	// lives and dies by the quality of its delegates, so the full specialist roster is the default.
	rpiByDefault: true,
	buildTools: ({ cwd, rpi, outputStore }) => [
		readTool({ cwd }),
		writeTool({ cwd }),
		editTool({ cwd }),
		applyPatchTool({ cwd }),
		skillTool(skillsFromDisk({ cwd })),
		subagentTool(modeSubagents({ cwd, rpi, ...(outputStore === undefined ? {} : { outputStore }) })),
	],
}
