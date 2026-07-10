/**
 * This file bundles the standard coding toolset (D17/D18): read, write, edit, apply_patch, bash,
 * web_fetch, and web_search over one shared FileSystem/cwd configuration. Install the whole bundle - the runtime's
 * ToolsetResolver advertises the family-appropriate subset per request (claude-family sees write/edit,
 * gpt/codex-family sees apply_patch) and re-resolves automatically when the session switches models.
 */
import type { TartTool } from '@humanlayer/tart-core'

import type { FsToolOptions } from '../Fs/DefaultFileSystem'
import { applyPatchTool } from './ApplyPatchTool'
import { bashTool, type BashToolOptions } from './BashTool'
import { editTool } from './EditTool'
import { readTool } from './ReadTool'
import { webTools, type WebToolsOptions } from './WebTools'
import { writeTool } from './WriteTool'

/** Options for {@link codingTools}: the shared filesystem seam plus bash output-spill configuration. */
export type CodingToolsOptions = FsToolOptions & Pick<BashToolOptions, 'spillDir' | 'outputStore'> & WebToolsOptions

/**
 * The standard coding toolset: read, write, edit, apply_patch, bash, and web tools. The model-family policy decides
 * which editing tools are advertised per request; installing the union is the intended setup.
 */
export const codingTools = (options?: CodingToolsOptions): ReadonlyArray<TartTool> => [
	readTool(options),
	writeTool(options),
	editTool(options),
	applyPatchTool(options),
	bashTool(options),
	...webTools(options),
]
