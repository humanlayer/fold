/**
 * This file bundles the file tools - read, write, edit, and apply_patch - over the ambient FileSystem.
 * It is also the `@humanlayer/fold-agent/tools/files` entry, for hosts such as Cloudflare Workers that
 * want these tools without the rest of fold-agent (bash, providers, config).
 */
import type { FoldTool } from '@humanlayer/fold-core'

import { applyPatchTool } from './ApplyPatchTool'
import { editTool } from './EditTool'
import { readTool } from './ReadTool'
import { writeTool } from './WriteTool'

export { applyPatchTool } from './ApplyPatchTool'
export { editTool } from './EditTool'
export { readTool } from './ReadTool'
export { writeTool } from './WriteTool'

/** read, write, edit, and apply_patch, resolving relative paths against `cwd`. */
export const fileTools = (options?: { readonly cwd?: string }): ReadonlyArray<FoldTool> => [
	readTool(options),
	writeTool(options),
	editTool(options),
	applyPatchTool(options),
]
