import type { FoldTool } from '@humanlayer/fold-core'
import type { HttpClient } from 'effect/http'

import type { Photon } from './Image/Photon'
import { webFetchTool } from './WebFetchTool'
import { webSearchTool, type WebSearchToolOptions } from './WebSearchTool'

export type WebToolsOptions = WebSearchToolOptions

export const webTools = (options?: WebToolsOptions): ReadonlyArray<FoldTool<HttpClient.HttpClient | Photon>> => [
	webFetchTool(),
	webSearchTool(options),
]
