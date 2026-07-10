/**
 * This file defines the `TartMode` primitive (D27): a mode is a pre-baked composition of a primary
 * model role, a mode system prompt, and a tool roster - the thing a CLI/OpenTUI selects ("coding",
 * later "rlm"/"rpi"). Launch (Mode/Launch) turns a mode plus the loaded config and agentfiles into a
 * running `TartSession` over tart-core's `startSession`/`resumeSession`.
 *
 * `defaultCodingMode` is the batteries-included local coding agent: the full filesystem toolset (read,
 * write, edit, apply_patch, bash - the family policy advertises the right editing subset per model),
 * the disk skill tool, and the default subagent roster (general-purpose, bash, researcher - see
 * Mode/Subagents). Other modes are just other `TartMode` values (Mode/Rlm); Mode/ModeName maps the
 * selectable names to them. RPI is not a mode: the `rpi` context flag appends the RPI specialist
 * roster to ANY mode's subagents (Mode/Rpi).
 */
import { skillTool, subagentTool, type TartTool } from '@humanlayer/tart-core'

import type { ConfigRole } from '../Config/ConfigSchema'
import { skillsFromDisk } from '../Skills/DiskSkills'
import { codingTools } from '../Tools/CodingTools'
import { modeSubagents } from './Rpi'
import type { ModeModels } from './Subagents'

/** Context handed to a mode when it builds its tool roster. */
export type ModeToolContext = {
	/** The session working directory (tools resolve relative paths and scan skills against it). */
	readonly cwd: string
	/**
	 * Models resolved from config roles, for modes that pin explicit models on their subagents (D21:
	 * explicit, never inherited). The default modes bind by profile role instead - launch passes these
	 * same resolved models as the session's profiles map.
	 */
	readonly models: ModeModels
	/** Install the RPI specialist subagents alongside the default roster (composable with any mode). */
	readonly rpi: boolean
}

/** A pre-baked agent composition: primary model role, mode prompt, and tool roster. */
export type TartMode = {
	/** Stable mode name (recorded as the agent name unless the caller overrides it). */
	readonly name: string
	/** Which config role the mode's primary agent runs on. */
	readonly role: ConfigRole
	/** The mode's leading system prompt block (composed before agentfiles and the skills block). */
	readonly systemPrompt?: string
	/** Build the mode's tool roster for a working directory. */
	readonly buildTools: (context: ModeToolContext) => ReadonlyArray<TartTool>
}

/** The default coding-agent system prompt. */
export const DEFAULT_CODING_PROMPT: string =
	"You are tart, a headless coding agent working in the user's project directory. " +
	'Use your tools to inspect and change files, run commands, and accomplish the task. ' +
	'Prefer reading before editing, make focused changes, and verify your work when you can. ' +
	'Delegate to a subagent when a step would burn context you need for the main task: researcher for ' +
	'locating and explaining code, web-search-researcher for current web research, bash for running a ' +
	'command and summarizing its output, and general-purpose for a self-contained multi-step task. Do simple work yourself. ' +
	'Keep responses concise; let the tools do the work.'

/** The batteries-included local coding agent: full filesystem toolset, disk skills, default subagents. */
export const defaultCodingMode: TartMode = {
	name: 'coding',
	role: 'smart',
	systemPrompt: DEFAULT_CODING_PROMPT,
	buildTools: ({ cwd, rpi }) => [
		...codingTools({ cwd }),
		skillTool(skillsFromDisk({ cwd })),
		subagentTool(modeSubagents({ cwd, rpi })),
	],
}
