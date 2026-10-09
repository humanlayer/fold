/**
 * This file owns agent-runtime provisioning - the one place a (model, tools, hooks) configuration
 * becomes a fully wired AgentRuntime. `Session.open` provisions the root agent's runtime here (once at
 * start, again on every model switch), and the subagent operations provision each subagent's runtime
 * here; both run inside the session's shared services, so every runtime shares the same EventLog, Ids,
 * AgentEvents spine, SystemPrompt, ModelRequestSettings, and ToolEventSink, while each provision gets its
 * own installed Toolset, family resolver, HookRunner, ToolRuntime, and provider LanguageModel layer.
 *
 * Two invariants live here and nowhere else:
 * - Every provision builds with a fresh `Layer.makeMemoMap`. v4 memoizes module-level layers by
 *   reference per memo map, so reusing a map would silently hand a new provision a previous
 *   provision's Toolset/ToolRuntime/AgentRuntime (the SessionIsolation regression).
 * - Every provision builds into the caller's ambient Scope. `Session.open` provides the session scope
 *   for root-agent provisions; a subagent provisions inside its dispatch call's scope, so its provider
 *   HTTP client releases when its dispatch returns instead of leaking for the session's lifetime.
 */
import { Array as Arr, Context, Effect, Layer } from 'effect'
import type { Scope } from 'effect'
import { LanguageModel, Toolkit } from 'effect/ai'
import type { Tool } from 'effect/ai'

import { liveAgentRuntimeLayer } from '../AgentRuntime/AgentRuntimeLayer'
import { AgentRuntime } from '../AgentRuntime/AgentRuntimeService'
import { compactionLayerFor } from '../Compaction/CompactionLayer'
import { layerHookRunner } from '../HookRunner/HookRunnerLayer'
import type { HookConfig } from '../HookRunner/Types'
import { SessionAgents } from '../Subagents/SessionAgents'
import { liveToolRuntimeLayer } from '../ToolRuntime/ToolRuntimeLayer'
import { toolsetLayerFromToolkit } from '../ToolRuntime/ToolsetFactory'
import { layerToolsetResolver } from '../ToolRuntime/ToolsetResolverLayer'
import type { FoldModel } from './ModelDescriptor'
import type { RealizedFoldTool, FoldTool } from './ToolDefinition'

/** The LanguageModel layer for a model: its `make`, run in the layer's scope. */
export const languageModelLayerFor = <R>(
	model: FoldModel<R>,
): Layer.Layer<LanguageModel.LanguageModel, never, Exclude<R, Scope.Scope>> =>
	Layer.effect(LanguageModel.LanguageModel, model.make)

/** Assemble realized tool descriptors into the installed Toolset layer for one provisioned runtime. */
export const toolsetLayerFor = (tools: ReadonlyArray<RealizedFoldTool>) => {
	const toolkit = Toolkit.make(...tools.map((foldTool) => foldTool.tool))
	const handlers: Toolkit.HandlersFrom<Record<string, Tool.Any>> = Object.fromEntries(
		tools.map((foldTool) => [foldTool.name, foldTool.handler]),
	)

	return toolsetLayerFromToolkit(toolkit).pipe(Layer.provide(toolkit.toLayer(handlers)))
}

/** Fail fast (as a defect) when two tool descriptors claim the same name. */
export const validateToolNames = (tools: ReadonlyArray<FoldTool<unknown>>): Effect.Effect<void> => {
	const duplicates = [
		...new Set(tools.map((tool) => tool.name).filter((name, index, names) => names.indexOf(name) !== index)),
	]

	return Arr.isArrayEmpty(duplicates)
		? Effect.void
		: Effect.die(new Error(`duplicate tool names: ${duplicates.join(', ')}`))
}

/** One agent's runtime configuration: which provider to talk to, with which tools and hooks. */
export type ProvisionAgentRuntimeInput = {
	readonly model: FoldModel<unknown>
	/**
	 * The tools installed for this agent, already realized (session-initialized values resolved to
	 * their contributions); the family resolver picks the advertised subset per turn.
	 */
	readonly tools: ReadonlyArray<RealizedFoldTool>
	/** This agent's own hook chains (D16); root and each subagent type carry theirs independently. */
	readonly hooks: HookConfig
}

/**
 * Provision one agent runtime into the ambient Scope: installed Toolset + family resolver + this
 * agent's HookRunner + ToolRuntime + the model's provider LanguageModel layer, built with a fresh memo
 * map. Everything else - the session's shared services and the host's - comes from the surroundings, so
 * this runs wherever those are present: `Session.open` for the root agent, and the subagent operations,
 * which run inside a tool call.
 */
export const provisionAgentRuntime = Effect.fnUntraced(function* (input: ProvisionAgentRuntimeInput) {
	const { autoCompact } = yield* SessionAgents
	const scope = yield* Effect.scope
	const memoMap = yield* Layer.makeMemoMap
	// Tool handlers run with the context their toolkit was built in (Effect AI merges it under each call's
	// per-call services), so building here gives every handler the session's and the host's services.
	const toolsetLayer = toolsetLayerFor(input.tools)
	// SAFETY: every model reaching a session came through Session.open, switchModel, or
	// setProfile, whose types require the model's services to be among the session's host services - and
	// the host services are part of the surroundings this runs in.
	// oxlint-disable-next-line typescript/consistent-type-assertions, automation/no-type-assertion
	const model = input.model as FoldModel
	const languageModelLayer = languageModelLayerFor(model)
	const epochServicesLayer = Layer.mergeAll(
		toolsetLayer,
		layerToolsetResolver().pipe(Layer.provide(toolsetLayer)),
		layerHookRunner(input.hooks),
	)
	// Compaction summarizes with this runtime's own model and resolves limits through the session
	// ModelCatalog; both are captured when the layer is built.
	const compactionLayer = compactionLayerFor(autoCompact).pipe(Layer.provide(languageModelLayer))
	const context = yield* Layer.buildWithMemoMap(
		liveAgentRuntimeLayer.pipe(
			Layer.provide(
				Layer.mergeAll(
					liveToolRuntimeLayer.pipe(Layer.provideMerge(epochServicesLayer)),
					languageModelLayer,
					compactionLayer,
				),
			),
		),
		memoMap,
		scope,
	)

	return Context.get(context, AgentRuntime)
})
