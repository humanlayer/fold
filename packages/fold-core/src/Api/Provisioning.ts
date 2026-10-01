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
import { Array as Arr, Context, Effect, Layer } from 'effect'
import type { Scope } from 'effect'
import { LanguageModel, Toolkit } from 'effect/unstable/ai'
import type { Tool } from 'effect/unstable/ai'

import type { AgentEvents } from '../AgentEvents/AgentEventsService'
import { liveAgentRuntimeLayer } from '../AgentRuntime/AgentRuntimeLayer'
import { AgentRuntime, type AgentRuntimeService } from '../AgentRuntime/AgentRuntimeService'
import { compactionLayerFor } from '../Compaction/CompactionLayer'
import type { AutoCompactConfig } from '../Compaction/CompactionService'
import type { EventLog } from '../EventLog/EventLogService'
import { layerHookRunner } from '../HookRunner/HookRunnerLayer'
import type { HookConfig } from '../HookRunner/Types'
import type { Ids } from '../Ids'
import type { ModelRequestSettings } from '../Model/ModelRequestSettings'
import type { SessionControls } from '../Session/SessionControls'
import type { Subagents } from '../Subagents/SubagentsService'
import type { SystemPrompt } from '../SystemPrompt/SystemPromptService'
import type { ToolEventSink } from '../ToolRuntime/ToolContextServices'
import { liveToolRuntimeLayer } from '../ToolRuntime/ToolRuntimeLayer'
import { toolsetLayerFromToolkit } from '../ToolRuntime/ToolsetFactory'
import { layerToolsetResolver } from '../ToolRuntime/ToolsetResolverLayer'
import type { FoldModel } from './ModelDescriptor'
import type { RealizedFoldTool, FoldTool } from './ToolDefinition'

export type SessionProvisioningServices =
	| EventLog
	| Ids
	| AgentEvents
	| SystemPrompt
	| ModelRequestSettings
	| ToolEventSink
	| Subagents
	| SessionControls

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
	autoCompact: AutoCompactConfig | undefined,
): AgentProvisionerService => ({
	provisionAgentRuntime: (input: ProvisionAgentRuntimeInput) =>
		Effect.gen(function* () {
			const scope = yield* Effect.scope
			const memoMap = yield* Layer.makeMemoMap
			// Tool handlers run with the context their toolkit was built in (Effect AI merges it under each
			// call's per-call services), so building over the session services gives every handler the
			// session's Subagents engine and platform services.
			const toolsetLayer = toolsetLayerFor(input.tools).pipe(Layer.provide(sessionServicesLayer))
			// SAFETY: every model reaching a session came through startSession, resumeSession, switchModel, or
			// setProfile, whose types require the model's services to be among the session's host services -
			// and the session services layer below provides those host services.
			// oxlint-disable-next-line typescript/consistent-type-assertions, automation/no-type-assertion
			const model = input.model as FoldModel
			// The model builds over the session's host services, like the tool handlers do.
			const languageModelLayer = languageModelLayerFor(model).pipe(Layer.provide(sessionServicesLayer))
			const epochServicesLayer = Layer.mergeAll(
				toolsetLayer,
				layerToolsetResolver().pipe(Layer.provide(toolsetLayer)),
				layerHookRunner(input.hooks).pipe(Layer.provide(sessionServicesLayer)),
			)
			const toolRuntimeLayer = liveToolRuntimeLayer.pipe(
				Layer.provideMerge(Layer.mergeAll(sessionServicesLayer, epochServicesLayer)),
			)
			// Compaction summarizes with this runtime's own model and resolves limits through the session
			// ModelCatalog; both are captured when the layer is built.
			const compactionLayer = compactionLayerFor(autoCompact).pipe(
				Layer.provide(Layer.mergeAll(languageModelLayer, sessionServicesLayer)),
			)
			const context = yield* Layer.buildWithMemoMap(
				liveAgentRuntimeLayer.pipe(
					Layer.provide(Layer.mergeAll(toolRuntimeLayer, languageModelLayer, compactionLayer)),
				),
				memoMap,
				scope,
			)

			return Context.get(context, AgentRuntime)
		}),
})
