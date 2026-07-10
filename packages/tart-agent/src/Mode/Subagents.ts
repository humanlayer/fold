/**
 * This file defines the default coding mode's subagent roster (D21/D27): three types the root agent can
 * dispatch, each a plain `SubagentDefinition` whose `tools` array carries its own capabilities.
 *
 * - `bash`         - bash only, no delegation. Runs commands and reports what happened.
 * - `researcher`   - read + bash + skills, no delegation and no editing tools (user ruling reversed
 *                    2026-07-09). Locates code and explains how it works with file:line references
 *                    (ported from the riptide-rpi codebase-analyzer / codebase-locator prompts, whose
 *                    Grep/Glob/LS tools collapse into find/rg/grep via bash here).
 * - `web-search-researcher` - web_search + web_fetch only, no delegation. Researches current docs and
 *                    public web sources with citations.
 * - `general-purpose` - the full coding toolset + skills + a roster of {general-purpose, bash,
 *                    researcher, web-search-researcher}. Takes a self-contained task end to end and may delegate.
 *
 * Depth is a roster choice, never an engine setting (D21): `bash` and `researcher` hold no
 * `subagentTool` value, so they cannot delegate at all; `general-purpose` holds one that includes
 * ITSELF, so general-purpose work can recurse.
 *
 * Models bind by profile ROLE name (profiles slice): `general-purpose` on `smart`, `researcher` and
 * `bash` on `fast`. Launch passes the config-resolved role models as the session's profiles map, so
 * the whole roster follows one `TartSession.setProfile` swap with no roster rebuild.
 */
import {
	defineSubagent,
	skillTool,
	subagentTool,
	type SubagentDefinition,
	type TartModel,
	type TartTool,
} from '@humanlayer/tart-core'

import { skillsFromDisk } from '../Skills/DiskSkills'
import { bashTool } from '../Tools/BashTool'
import { codingTools } from '../Tools/CodingTools'
import { readTool } from '../Tools/ReadTool'
import { webTools } from '../Tools/WebTools'

/** The models a mode binds its agents to, resolved from config roles (or a single explicit override). */
export type ModeModels = {
	/** The root agent's model: the mode's role, or whatever the caller selected/overrode. */
	readonly primary: TartModel
	readonly smart: TartModel
	readonly fast: TartModel
	/** Falls back to `smart` when the config declares no orchestrator role (D25). */
	readonly orchestrator: TartModel
}

/** Inputs for building a subagent roster against one working directory. */
export type SubagentRosterOptions = {
	readonly cwd: string
}

/** Leading prompt for the `bash` subagent. */
export const BASH_SUBAGENT_PROMPT: string =
	'You are the bash subagent. You execute shell commands on behalf of a parent agent and report back ' +
	'what happened.\n\n' +
	'- bash is your only tool. You cannot read or edit files except through commands.\n' +
	'- Prefer `rg` over `grep` for content search and `fd` over `find` for filename search (tart ' +
	'provides both, plus `ast-grep` for structural code search - `ast-grep outline <file>` maps a file).\n' +
	'- Run the smallest set of commands that answers the request, and quote paths that may contain spaces.\n' +
	'- Do not change state the request did not ask you to change: no commits, pushes, installs, deploys, ' +
	'or destructive filesystem operations unless you were explicitly told to run them.\n' +
	'- You cannot ask clarifying questions. If the request is ambiguous, take the most conservative ' +
	'reading and say what you assumed.\n\n' +
	'Report the exact commands you ran, their exit status, and only the output that matters - trim the ' +
	'noise, but quote failures verbatim. Your parent sees your final message, not your tool calls.'

/** Leading prompt for the `researcher` subagent (riptide-rpi codebase-analyzer/locator, ported). */
export const RESEARCHER_SUBAGENT_PROMPT: string =
	'You are the researcher subagent: a specialist at finding code and explaining HOW it works, with ' +
	'precise file:line references.\n\n' +
	'## Your only job is to document the codebase as it exists today\n' +
	'- DO NOT suggest improvements, refactors, or optimizations\n' +
	'- DO NOT critique code quality, performance, or security\n' +
	'- DO NOT perform root-cause analysis or propose fixes unless you were explicitly asked to\n' +
	'- ONLY describe what exists, where it lives, and how the pieces interact\n' +
	'You are a documentarian, not a critic.\n\n' +
	'## How to search\n' +
	'You have read and bash - search with `find`, `rg`, and `grep` via bash:\n' +
	'- `rg -n "pattern" path` (or `grep -rn`) to search contents with line numbers\n' +
	'- `rg --files -g "**/*.ts"` (or `find`) to list files by name pattern\n' +
	'- Then read the files you found. Never make a claim about a file you have not read.\n\n' +
	'## Output format\n' +
	'```\n' +
	'## Research: <topic>\n\n' +
	'### Summary\n' +
	'[2-3 sentences]\n\n' +
	'### Key locations\n' +
	'- `path/to/file.ts:45` - what lives here\n\n' +
	'### How it works\n' +
	'1. Entry point at `path/to/file.ts:12`\n' +
	'2. ...each step anchored to a file:line\n\n' +
	'### Related files\n' +
	'- `path/to/other.ts` - why it is relevant\n' +
	'```\n\n' +
	'Always include file:line references. Quote short snippets, never whole files. If you could not find ' +
	'something, say so plainly rather than guessing. You have no editing tools - changing files is not ' +
	'your job.'

/**
 * Shared structural-navigation guidance appended AFTER the research/review prompts as its own leading
 * block (user-directed 2026-07-09 addition; it rides beside the faithful prompt ports, never spliced
 * into ported source text). Commands per the ast-grep outline announcement (requires ast-grep 0.44.0+).
 */
export const AST_GREP_OUTLINE_GUIDANCE: string =
	'## Structural outlines with ast-grep\n\n' +
	'Before reading full source files, get a structural map with `ast-grep outline` via bash:\n' +
	'- `ast-grep outline path/to/file.ts` - a table of contents for one file: functions, classes, ' +
	'imports, exports, and source ranges\n' +
	"- `ast-grep outline src/` - a directory's exported surface\n" +
	'- `ast-grep outline path/to/file.ts --match SymbolName --view expanded` - focus one symbol and ' +
	'expand its local details\n\n' +
	'`ast-grep outline` needs ast-grep 0.44.0 or newer. tart installs `ast-grep` (along with `rg` and ' +
	'`fd`) into `~/.tart/bin` automatically, so it is usually already on your PATH. If ' +
	'`ast-grep --version` still fails or reports an older version, install it yourself: ' +
	'`npm i -g @ast-grep/cli` (or `brew install ast-grep`). Prefer an outline first pass over broad ' +
	'file reading; read full files only for the parts that matter.'

/** Leading prompt for the `general-purpose` subagent. */
export const GENERAL_PURPOSE_SUBAGENT_PROMPT: string =
	'You are the general-purpose subagent. You take a self-contained task from a parent agent, carry it ' +
	'out end to end, and report the result.\n\n' +
	'You have the full coding toolset, skills, and your own roster of subagents:\n' +
	'- `researcher` - locating code or explaining how something works across many files\n' +
	'- `web-search-researcher` - researching current web sources, docs, changelogs, and forums\n' +
	'- `bash` - running a command and summarizing its output\n' +
	'- `general-purpose` - an independent sub-task you would otherwise interleave with your own\n\n' +
	'Delegate only when it saves you real context. Each dispatch costs a full model call, so never ' +
	'dispatch a subagent for something you could finish in one or two tool calls, and do not nest deeply ' +
	'- prefer doing the work yourself.\n\n' +
	'Your parent sees only your final message, not your tool calls. End with what you did, what you ' +
	'found (file:line where relevant), and anything you could not complete.'

/** Leading prompt for `web-search-researcher` (agentlayer specialist, backed by web_search/web_fetch). */
export const WEB_SEARCH_RESEARCHER_PROMPT: string =
	'You research up-to-date information from documentation, blogs, changelogs, and forums. Use ' +
	'`web_search` to discover sources and `web_fetch` to retrieve specific high-value pages.\n\n' +
	'## Core Responsibilities\n\n' +
	'1. Search for official documentation first\n' +
	'2. Gather recent and relevant technical context\n' +
	'3. Summarize the answer clearly with source URLs when helpful\n\n' +
	'## Guidelines\n\n' +
	'- Prioritize official documentation\n' +
	'- Prefer concise, relevant findings over broad digressions\n' +
	'- Fetch promising results instead of relying on snippets alone\n' +
	'- Call out uncertainty when sources disagree'

/**
 * Build the default roster for a working directory. The skill source is one shared value across the
 * types that get skills, so the session scans the skills directory exactly once (D20). Every type
 * binds its model by profile role, resolved through the session's profiles map at each dispatch.
 */
export const defaultSubagents = ({ cwd }: SubagentRosterOptions): ReadonlyArray<SubagentDefinition> => {
	const coding = codingTools({ cwd })
	const skills = skillTool(skillsFromDisk({ cwd }))
	const web = webTools()

	const bash = defineSubagent({
		name: 'bash',
		description:
			'Run shell commands (builds, tests, git, rg searches) and report the commands, exit status, and ' +
			'the output that matters. Use it to execute something without spending your own context on raw output.',
		systemPrompt: BASH_SUBAGENT_PROMPT,
		tools: [bashTool({ cwd })],
		model: 'fast',
	})

	// Read + bash + skill ONLY (user ruling reversed 2026-07-09): the researcher is a documentarian, so
	// it holds no write/edit/apply_patch value at all rather than being merely told not to edit.
	const researcher = defineSubagent({
		name: 'researcher',
		description:
			'Locate code and explain how it works, returning a structured report with file:line references. ' +
			'Use it for "where is X" and "how does Y work" questions that would otherwise require reading many files.',
		systemPrompt: [RESEARCHER_SUBAGENT_PROMPT, AST_GREP_OUTLINE_GUIDANCE],
		tools: [readTool({ cwd }), bashTool({ cwd }), skills],
		model: 'fast',
	})

	const webSearchResearcher = defineSubagent({
		name: 'web-search-researcher',
		description:
			'Researches web sources for up-to-date technical information. Use when you need documentation, ' +
			'guides, changelogs, or forum context from the public web.',
		systemPrompt: WEB_SEARCH_RESEARCHER_PROMPT,
		tools: web,
		model: 'fast',
	})

	// general-purpose dispatches ITSELF, so its roster cannot exist before the definition does. The tools
	// array is built first, handed to the definition, then closed over its own subagentTool value. The
	// registry walk dedups by identity and carries a seen-set, so the resulting cycle is traversal-safe
	// (see tart-core `collectSubagentDefinitions`).
	const generalPurposeTools: Array<TartTool> = [...coding, skills]
	const generalPurpose = defineSubagent({
		name: 'general-purpose',
		description:
			'Handle a multi-step task end to end: research the code, edit files, and run commands. Can delegate ' +
			'to researcher, bash, and further general-purpose agents. Use it for self-contained work you want ' +
			'done without spending your own context on the intermediate steps.',
		systemPrompt: GENERAL_PURPOSE_SUBAGENT_PROMPT,
		tools: generalPurposeTools,
		model: 'smart',
	})
	generalPurposeTools.push(subagentTool([generalPurpose, bash, researcher, webSearchResearcher]))

	return [generalPurpose, bash, researcher, webSearchResearcher]
}
