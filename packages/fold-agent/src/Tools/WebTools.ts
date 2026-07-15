import type { FoldTool } from '@humanlayer/fold-core'

import { webFetchTool } from './WebFetchTool'
import { webSearchTool, type WebSearchToolOptions } from './WebSearchTool'

export type WebToolsOptions = WebSearchToolOptions

export const webTools = (options?: WebToolsOptions): ReadonlyArray<FoldTool> => [webFetchTool(), webSearchTool(options)]
