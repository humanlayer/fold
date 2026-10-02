/**
 * This file bundles the standard coding toolset (D17/D18): read, write, edit, apply_patch, bash,
 * web_fetch, and web_search over one shared FileSystem/cwd configuration. Install the whole bundle - the runtime's
 * ToolsetResolver advertises the family-appropriate subset per request (claude-family sees write/edit,
 * gpt/codex-family sees apply_patch) and re-resolves automatically when the session switches models.
 */
import * as NodeServices from '@effect/platform-node/NodeServices'
import type { FoldTool } from '@humanlayer/fold-core'
import { type FileSystem, Layer, type Path } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http'
import type { ChildProcessSpawner } from 'effect/unstable/process'

import { layerOutputStore, type OutputStore } from '../OutputStore/OutputStore'
import { bashTool, type BashToolOptions } from './BashTool'
import { fileTools } from './FileTools'
import { Photon } from './Image/Photon'
import { webTools, type WebToolsOptions } from './WebTools'

/** Options for {@link codingTools}: the shared cwd plus bash output-spill configuration. */
export type CodingToolsOptions = Pick<BashToolOptions, 'cwd' | 'processEnvironment'> & WebToolsOptions

/**
 * The standard coding toolset: read, write, edit, apply_patch, bash, and web tools. The model-family policy decides
 * which editing tools are advertised per request; installing the union is the intended setup.
 */
export const codingTools = (
	options?: CodingToolsOptions,
): ReadonlyArray<
	FoldTool<
		| FileSystem.FileSystem
		| Path.Path
		| ChildProcessSpawner.ChildProcessSpawner
		| OutputStore
		| Photon
		| HttpClient.HttpClient
	>
> => [...fileTools(options), bashTool(options), ...webTools(options)]

/**
 * Every coding-tool host service on Node, for hosts that start sessions themselves: the Node platform,
 * a fetch-backed HTTP client, photon, and an output store writing into `outputDirectory`.
 */
export const layerCodingToolServices = (options: {
	readonly outputDirectory: string
}): Layer.Layer<
	| FileSystem.FileSystem
	| Path.Path
	| ChildProcessSpawner.ChildProcessSpawner
	| OutputStore
	| Photon
	| HttpClient.HttpClient
> =>
	Layer.mergeAll(
		NodeServices.layer,
		FetchHttpClient.layer,
		Photon.layer,
		layerOutputStore({ directory: options.outputDirectory }).pipe(Layer.provide(NodeServices.layer)),
	)
