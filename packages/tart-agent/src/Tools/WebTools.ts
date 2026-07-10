import type { TartTool } from '@humanlayer/tart-core'

import { webFetchTool } from './WebFetchTool'
import { webSearchTool, type WebSearchToolOptions } from './WebSearchTool'

export type WebToolsOptions = WebSearchToolOptions

export const webTools = (options?: WebToolsOptions): ReadonlyArray<TartTool> => [webFetchTool(), webSearchTool(options)]
