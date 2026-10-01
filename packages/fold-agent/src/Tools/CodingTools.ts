/**
 * This file bundles the standard coding toolset (D17/D18): read, write, edit, apply_patch, bash,
 * web_fetch, and web_search over one shared FileSystem/cwd configuration. Install the whole bundle - the runtime's
 * ToolsetResolver advertises the family-appropriate subset per request (claude-family sees write/edit,
 * gpt/codex-family sees apply_patch) and re-resolves automatically when the session switches models.
 */
import type { FoldTool } from '@humanlayer/fold-core'

import { bashTool, type BashToolOptions } from './BashTool'
import { fileTools } from './FileTools'
import { webTools, type WebToolsOptions } from './WebTools'

/** Options for {@link codingTools}: the shared cwd plus bash output-spill configuration. */
export type CodingToolsOptions = Pick<BashToolOptions, 'cwd' | 'spillDir' | 'outputStore' | 'processEnvironment'> &
	WebToolsOptions

/**
 * The standard coding toolset: read, write, edit, apply_patch, bash, and web tools. The model-family policy decides
 * which editing tools are advertised per request; installing the union is the intended setup.
 */
export const codingTools = (options?: CodingToolsOptions): ReadonlyArray<FoldTool> => [
	...fileTools(options),
	bashTool(options),
	...webTools(options),
]
