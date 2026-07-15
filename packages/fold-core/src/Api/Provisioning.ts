/**
 * This file owns agent-runtime provisioning - the one place a (model, tools, hooks) configuration
 * becomes a fully wired AgentRuntime over a session's shared services. `startSession` provisions the
 * root agent's runtime here (once at start, again on every model switch), and the Subagents service
 * provisions each dispatched subagent's runtime here; both therefore share the same EventLog, Ids,
 * AgentEvents spine, SystemPrompt, ModelRequestSettings, and ToolEventSink by construction, while each
 * provision gets its own installed Toolset, family resolver, HookRunner, ToolRuntime, and provider
 * LanguageModel layer.
 *
 * Two invariants live here and nowhere else:
 * - Every provision builds with a fresh `Layer.makeMemoMap`. v4 memoizes module-level layers by
 *   reference per memo map, so reusing a map would silently hand a new provision a previous
 *   provision's Toolset/ToolRuntime/AgentRuntime (the SessionIsolation regression).
 * - Every provision builds into the caller's ambient Scope. The facade provides the session scope for
 *   root-agent provisions; Subagents provisions inside the dispatch call's scope, so a subagent's
 *   provider HTTP client releases when its dispatch returns instead of leaking for the session's
 *   lifetime.
 */
import { AnthropicClient, AnthropicLanguageModel } from '@effect/ai-anthropic'
import { OpenAiClient, OpenAiLanguageModel } from '@effect/ai-openai'
import { Context, Effect, Layer, Stream } from 'effect'
import type { Scope } from 'effect'
import { LanguageModel, Toolkit } from 'effect/unstable/ai'
import type { Tool } from 'effect/unstable/ai'
import { FetchHttpClient, HttpClient, type HttpClientResponse } from 'effect/unstable/http'

import type { AgentEvents } from '../AgentEvents/AgentEventsService'
import { liveAgentRuntimeLayer } from '../AgentRuntime/AgentRuntimeLayer'
import { AgentRuntime, type AgentRuntimeService } from '../AgentRuntime/AgentRuntimeService'
import type { EventLog } from '../EventLog/EventLogService'
import { makeHookRunner } from '../HookRunner/HookRunnerLayer'
import type { HookConfig } from '../HookRunner/Types'
import type { Ids } from '../Ids'
import type { ModelRequestSettings } from '../Model/ModelRequestSettings'
import type { SessionControls } from '../Session/SessionControls'
import type { Subagents } from '../Subagents/SubagentsService'
import type { SystemPrompt } from '../SystemPrompt/SystemPromptService'
import type { ToolEventSink } from '../ToolRuntime/ToolContextServices'
import { liveToolRuntimeLayer } from '../ToolRuntime/ToolRuntimeLayer'
import { toolsetLayerFromToolkit } from '../ToolRuntime/ToolsetFactory'
import { makeToolsetResolver } from '../ToolRuntime/ToolsetResolverLayer'
import type { FoldModel } from './ModelDescriptor'
import type { RealizedFoldTool, FoldTool } from './ToolDefinition'

const anthropicDecoderModelFor = (modelId: string): string | null => {
	const id = modelId.toLowerCase()
	if (id.includes('opus')) return id === 'claude-opus-4-6' ? null : 'claude-opus-4-6'
	if (id.includes('sonnet')) return id === 'claude-sonnet-4-6' ? null : 'claude-sonnet-4-6'
	if (id.includes('haiku')) return id === 'claude-haiku-4-5' ? null : 'claude-haiku-4-5'
	if (id.includes('fable') || id.includes('mythos')) return 'claude-opus-4-6'
	return null
}

/**
 * The beta Anthropic SDK decodes streamed `message.model` against a generated literal union that can
 * lag behind real model ids accepted by the API. Rewrite only that metadata field in the raw SSE bytes
 * to a decoder-known sibling; the actual request still uses the configured model id.
 */
const relaxAnthropicResponseModel = (modelId: string): ((client: HttpClient.HttpClient) => HttpClient.HttpClient) => {
	const decoderModel = anthropicDecoderModelFor(modelId)
	if (decoderModel === null) return (client) => client

	const needle = `"model":"${modelId}"`
	const replacement = `"model":"${decoderModel}"`

	return (client) =>
		HttpClient.transformResponse(client, (responseEffect) =>
			Effect.map(responseEffect, (response) => {
				const stream = response.stream.pipe(
					Stream.decodeText,
					Stream.map((chunk) => chunk.replaceAll(needle, replacement)),
					Stream.encodeText,
				)

				// SAFETY: this preserves the HttpClientResponse instance and only overrides the streaming body
				// getter. The Anthropic generated client only needs `stream` for createMessageStream.
				// oxlint-disable-next-line typescript/consistent-type-assertions
				return new Proxy(response, {
					get: (target, property, receiver) =>
						property === 'stream' ? stream : Reflect.get(target, property, receiver),
				}) as HttpClientResponse.HttpClientResponse
			}),
		)
}

/** The session-fixed services every provisioned runtime closes over (one instance each per session). */
export type SessionProvisioningServices =
	| EventLog
	| Ids
	| AgentEvents
	| SystemPrompt
	| ModelRequestSettings
	| ToolEventSink
	| Subagents
	| SessionControls

/** Lower a model descriptor to the LanguageModel layer for its provider connection. */
export const languageModelLayerFor = (model: FoldModel): Layer.Layer<LanguageModel.LanguageModel> => {
	const provider = model.provider

	switch (provider._tag) {
		case 'openai-compatible': {
			const clientLayer = OpenAiClient.layer({
				apiKey: provider.apiKey,
				...(provider.baseUrl === null ? {} : { apiUrl: provider.baseUrl }),
			}).pipe(Layer.provide(FetchHttpClient.layer))

			return OpenAiLanguageModel.layer({ model: model.activeModel.modelId }).pipe(Layer.provide(clientLayer))
		}

		case 'anthropic': {
			const clientLayer = AnthropicClient.layer({
				apiKey: provider.apiKey,
				transformClient: relaxAnthropicResponseModel(model.activeModel.modelId),
				...(provider.baseUrl === null ? {} : { apiUrl: provider.baseUrl }),
			}).pipe(Layer.provide(FetchHttpClient.layer))

			return AnthropicLanguageModel.layer({ model: model.activeModel.modelId }).pipe(Layer.provide(clientLayer))
		}

		case 'custom':
			return Layer.effect(LanguageModel.LanguageModel, provider.make)
	}
}

/** Assemble realized tool descriptors into the installed Toolset layer for one provisioned runtime. */
export const toolsetLayerFor = (tools: ReadonlyArray<RealizedFoldTool>) => {
	const toolkit = Toolkit.make(...tools.map((foldTool) => foldTool.tool))
	// SAFETY: the dispatch table is keyed by tool name over erased handlers; each handler is only ever
	// invoked with params decoded by its own tool's parameters schema (see defineTool). This mirrors
	// the sanctioned dynamic-dispatch assertion in ToolsetFactory.
	// oxlint-disable-next-line typescript/consistent-type-assertions
	const handlers = Object.fromEntries(
		tools.map((foldTool) => [foldTool.name, foldTool.handler]),
	) as Toolkit.HandlersFrom<Record<string, Tool.Any>>

	return toolsetLayerFromToolkit(toolkit).pipe(Layer.provide(toolkit.toLayer(handlers)))
}

/** Fail fast (as a defect) when two tool descriptors claim the same name. */
export const validateToolNames = (tools: ReadonlyArray<FoldTool>): Effect.Effect<void> => {
	const duplicates = [
		...new Set(tools.map((tool) => tool.name).filter((name, index, names) => names.indexOf(name) !== index)),
	]

	return duplicates.length === 0
		? Effect.void
		: Effect.die(new Error(`duplicate tool names: ${duplicates.join(', ')}`))
}

/** One agent's runtime configuration: which provider to talk to, with which tools and hooks. */
export type ProvisionAgentRuntimeInput = {
	readonly model: FoldModel
	/**
	 * The tools installed for this agent, already realized (session-initialized values resolved to
	 * their contributions); the family resolver picks the advertised subset per turn.
	 */
	readonly tools: ReadonlyArray<RealizedFoldTool>
	/** This agent's own hook chains (D16); root and each subagent type carry theirs independently. */
	readonly hooks: HookConfig
}

/** Builds a fully-wired AgentRuntime for one agent over the shared session services. */
export type AgentProvisionerService = {
	/**
	 * Provision one agent runtime into the ambient Scope: installed Toolset + family resolver + this
	 * agent's HookRunner + ToolRuntime + the model's provider LanguageModel layer, built with a fresh
	 * memo map over the session-fixed services.
	 */
	readonly provisionAgentRuntime: (
		input: ProvisionAgentRuntimeInput,
	) => Effect.Effect<AgentRuntimeService, never, Scope.Scope>
}

/** AgentProvisioner service tag (the interim D15 AgentModels seam, shared by facade and Subagents). */
export class AgentProvisioner extends Context.Service<AgentProvisioner, AgentProvisionerService>()(
	'fold/AgentProvisioner',
) {}

/**
 * Build the provisioner over one session's shared services. The facade constructs this once per
 * session, right after building `sessionServicesLayer`, and hands it to the Subagents service.
 */
export const makeAgentProvisioner = (
	sessionServicesLayer: Layer.Layer<SessionProvisioningServices>,
): AgentProvisionerService => ({
	provisionAgentRuntime: (input: ProvisionAgentRuntimeInput) =>
		Effect.gen(function* () {
			const scope = yield* Effect.scope
			const memoMap = yield* Layer.makeMemoMap
			const toolsetLayer = toolsetLayerFor(input.tools)
			const epochServicesLayer = Layer.mergeAll(
				toolsetLayer,
				makeToolsetResolver().pipe(Layer.provide(toolsetLayer)),
				makeHookRunner(input.hooks).pipe(Layer.provide(sessionServicesLayer)),
			)
			const toolRuntimeLayer = liveToolRuntimeLayer.pipe(
				Layer.provideMerge(Layer.mergeAll(sessionServicesLayer, epochServicesLayer)),
			)
			const context = yield* Layer.buildWithMemoMap(
				liveAgentRuntimeLayer.pipe(
					Layer.provide(Layer.mergeAll(toolRuntimeLayer, languageModelLayerFor(input.model))),
				),
				memoMap,
				scope,
			)

			return Context.get(context, AgentRuntime)
		}),
})
