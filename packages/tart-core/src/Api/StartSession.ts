/**
 * This file implements `startSession` - the ergonomic composition root of the public API. Callers
 * describe an agent (model, prompt, tools, hooks) and optionally an event log backend; this file lowers
 * those descriptors into the internal service graph (EventLog, Ids, AgentEvents, SystemPrompt,
 * ModelRequestSettings, HookRunner, and per-epoch Toolset + resolver + ToolRuntime + AgentRuntime,
 * plus the Session facade) and returns a running session handle. Per the composition-root ruling, this
 * is the only place descriptors become layers; no public signature accepts or returns one.
 *
 * Configuration switching: the AgentRuntime consumed by the Session is a delegating facade over a Ref
 * of the currently provisioned runtime. `TartSession.switchModel` provisions a runtime for the new
 * provider - and, when requested, a new installed toolset - into the session scope, swaps the Ref, then
 * writes the durable epoch transition through the Session service (`model-change`, recomposed leading
 * `system-message`, `tools-change` resolved over the newly installed tools, and `thinking-change` when
 * the reasoning level changed - D17/D23). The next send runs the new configuration against the same
 * durable log. This Ref is the interim form of the D15 AgentModels provisioning seam.
 */
import { AnthropicClient, AnthropicLanguageModel } from '@effect/ai-anthropic'
import { OpenAiClient, OpenAiLanguageModel } from '@effect/ai-openai'
import { Context, Effect, Layer, Ref, Schema, Semaphore, Stream } from 'effect'
import type { Scope } from 'effect'
import { LanguageModel, Toolkit } from 'effect/unstable/ai'
import type { Tool } from 'effect/unstable/ai'
import { FetchHttpClient } from 'effect/unstable/http'

import { toolEventSinkLayerFromAgentEvents, liveAgentEventsLayer } from '../AgentEvents/AgentEventsLayer'
import type { TartEvent } from '../AgentEvents/AgentEventsService'
import { liveAgentRuntimeLayer } from '../AgentRuntime/AgentRuntimeLayer'
import { AgentRuntime, type AgentRuntimeService } from '../AgentRuntime/AgentRuntimeService'
import { layerInMemoryEventLog } from '../EventLog/EventLogLayerMemory'
import { EventLog } from '../EventLog/EventLogService'
import type { AgentFinishedLogEntry, LogEntry, LogSeq } from '../EventLog/Schemas'
import { makeHookRunner } from '../HookRunner/HookRunnerLayer'
import { layerLiveIdFactory, type AgentId, type SessionId } from '../Ids'
import { liveModelRequestSettingsLayer } from '../Model/ModelRequestSettings'
import { liveSessionLayer } from '../Session/SessionLayer'
import { Session } from '../Session/SessionService'
import { makeSystemPrompt } from '../SystemPrompt/SystemPromptLayer'
import { liveToolRuntimeLayer } from '../ToolRuntime/ToolRuntimeLayer'
import { toolsetLayerFromToolkit } from '../ToolRuntime/ToolsetFactory'
import { makeToolsetResolver } from '../ToolRuntime/ToolsetResolverLayer'
import type { AgentDefinition } from './AgentDefinition'
import type { TartEventLog } from './EventLogDescriptor'
import type { TartModel } from './ModelDescriptor'
import type { TartTool } from './ToolDefinition'

/** Options for {@link startSession}. */
export type StartSessionOptions = {
	readonly agent: AgentDefinition
	/** Event log backend for the session. Defaults to in-memory. */
	readonly log?: TartEventLog
	/** Host working directory recorded on `session_started`; omit on hosts without a filesystem. */
	readonly cwd?: string
	readonly meta?: Readonly<Record<string, typeof Schema.Json.Type>>
}

/** Options for {@link TartSession.switchModel}. Omitted fields keep the session's current configuration. */
export type SwitchModelOptions = {
	readonly reason?: string
	/** Replace the agent's own leading prompt blocks from this epoch on. */
	readonly systemPrompt?: string | ReadonlyArray<string>
	/** Replace the installed tools from this epoch on. */
	readonly tools?: ReadonlyArray<TartTool>
}

/**
 * A running tart session: one durable log, one root agent, already started. Every method is safe to
 * call without further wiring; `send` and `switchModel` are serialized against each other so a switch
 * cannot interleave with an in-flight run.
 */
export type TartSession = {
	readonly sessionId: SessionId
	readonly rootAgentId: AgentId
	/** Run one user turn on the root agent and resolve with the durable `agent-finished` entry. */
	readonly send: (text: string) => Effect.Effect<AgentFinishedLogEntry>
	/**
	 * Switch the root agent to a different provider/model, optionally replacing its prompt blocks and
	 * installed tools in the same transition. Durably records the epoch transition - `model-change`, the
	 * recomposed leading `system-message`, `tools-change` over the (possibly new) installed toolset, and
	 * `thinking-change` when the reasoning level changed - and provisions the new configuration for every
	 * subsequent send. The same log continues across the switch.
	 */
	readonly switchModel: (model: TartModel, options?: SwitchModelOptions) => Effect.Effect<void>
	/** Merged stream of durable log rows and ephemeral streaming deltas. */
	readonly events: (fromSeq?: LogSeq) => Stream.Stream<TartEvent>
	/** Snapshot of all durable log entries appended so far. */
	readonly entries: Effect.Effect<ReadonlyArray<LogEntry>>
	readonly interrupt: Effect.Effect<void>
}

/** The switchable slice of a session's configuration, tracked so omitted switch options carry forward. */
type SessionAgentConfig = {
	readonly systemPrompt: string | ReadonlyArray<string> | null
	readonly tools: ReadonlyArray<TartTool>
}

/** Lower the event log descriptor to its EventLog layer. */
const eventLogLayerFor = (log: TartEventLog): Layer.Layer<EventLog, unknown> =>
	log._tag === 'memory' ? layerInMemoryEventLog : Layer.effect(EventLog, log.make)

/** Lower a model descriptor to the LanguageModel layer for its provider connection. */
const languageModelLayerFor = (model: TartModel): Layer.Layer<LanguageModel.LanguageModel> => {
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
				...(provider.baseUrl === null ? {} : { apiUrl: provider.baseUrl }),
			}).pipe(Layer.provide(FetchHttpClient.layer))

			return AnthropicLanguageModel.layer({ model: model.activeModel.modelId }).pipe(Layer.provide(clientLayer))
		}

		case 'custom':
			return Layer.effect(LanguageModel.LanguageModel, provider.make)
	}
}

/** Assemble tool descriptors into the installed Toolset layer for one epoch. */
const toolsetLayerFor = (tools: ReadonlyArray<TartTool>) => {
	const toolkit = Toolkit.make(...tools.map((tartTool) => tartTool.tool))
	// SAFETY: the dispatch table is keyed by tool name over erased handlers; each handler is only ever
	// invoked with params decoded by its own tool's parameters schema (see defineTool). This mirrors
	// the sanctioned dynamic-dispatch assertion in ToolsetFactory.
	// oxlint-disable-next-line typescript/consistent-type-assertions
	const handlers = Object.fromEntries(
		tools.map((tartTool) => [tartTool.name, tartTool.handler]),
	) as Toolkit.HandlersFrom<Record<string, Tool.Any>>

	return toolsetLayerFromToolkit(toolkit).pipe(Layer.provide(toolkit.toLayer(handlers)))
}

/** Fail fast (as a defect) when two tool descriptors claim the same name. */
const validateToolNames = (tools: ReadonlyArray<TartTool>): Effect.Effect<void> => {
	const duplicates = [
		...new Set(tools.map((tool) => tool.name).filter((name, index, names) => names.indexOf(name) !== index)),
	]

	return duplicates.length === 0
		? Effect.void
		: Effect.die(new Error(`duplicate tool names: ${duplicates.join(', ')}`))
}

/**
 * Start one session for the given agent definition and return its running handle. The session lives in
 * the surrounding scope: closing the scope releases the log backend, event spine, and provisioned model
 * runtimes.
 */
export const startSession = (options: StartSessionOptions): Effect.Effect<TartSession, never, Scope.Scope> =>
	Effect.gen(function* () {
		const agent = options.agent
		const initialConfig: SessionAgentConfig = {
			systemPrompt: agent.systemPrompt ?? null,
			tools: agent.tools ?? [],
		}
		yield* validateToolNames(initialConfig.tools)

		// One shared service graph per session; every provisioned epoch runtime closes over these same
		// instances (one EventLog, one Ids source, one AgentEvents PubSub, one HookRunner).
		const infraLayer = Layer.mergeAll(
			eventLogLayerFor(options.log ?? { _tag: 'memory' }),
			layerLiveIdFactory,
			liveAgentEventsLayer,
		)
		const servicesLayer = Layer.mergeAll(
			infraLayer,
			makeSystemPrompt(agent.basePrompts === undefined ? {} : { basePrompts: agent.basePrompts }),
			liveModelRequestSettingsLayer,
			makeHookRunner(agent.hooks ?? {}).pipe(Layer.provide(infraLayer)),
			toolEventSinkLayerFromAgentEvents.pipe(Layer.provide(infraLayer)),
		)
		// Builds use session-fresh memo maps, never the ambient CurrentMemoMap: layers are memoized by
		// reference per memo map, and under `Effect.provide` (any app or test harness) the ambient map
		// would share module-level layers - the event log, the event spine - across sessions, and hand
		// every model switch the previous epoch's memoized runtime.
		const sessionScope = yield* Effect.scope
		const sessionMemoMap = yield* Layer.makeMemoMap
		const sessionServices = yield* Layer.buildWithMemoMap(servicesLayer, sessionMemoMap, sessionScope).pipe(
			Effect.orDie,
		)
		const sessionServicesLayer = Layer.succeedContext(sessionServices)

		// Provision one runtime slice per epoch into the session scope: the installed Toolset, its family
		// resolver, the ToolRuntime executing against it, and the AgentRuntime bound to the model's
		// provider. The delegating runtime below lets the Session service survive swaps (interim
		// AgentModels seam - D15). Each provision builds with its own memo map so these module-level
		// layers rebuild against the new model and toolset instead of hitting a previous epoch's
		// memoized instances.
		const provisionRuntime = (
			model: TartModel,
			tools: ReadonlyArray<TartTool>,
		): Effect.Effect<AgentRuntimeService> =>
			Effect.gen(function* () {
				const memoMap = yield* Layer.makeMemoMap
				const toolsetLayer = toolsetLayerFor(tools)
				const epochServicesLayer = Layer.mergeAll(
					toolsetLayer,
					makeToolsetResolver().pipe(Layer.provide(toolsetLayer)),
				)
				const toolRuntimeLayer = liveToolRuntimeLayer.pipe(
					Layer.provideMerge(Layer.mergeAll(sessionServicesLayer, epochServicesLayer)),
				)
				const context = yield* Layer.buildWithMemoMap(
					liveAgentRuntimeLayer.pipe(
						Layer.provide(Layer.mergeAll(toolRuntimeLayer, languageModelLayerFor(model))),
					),
					memoMap,
					sessionScope,
				)

				return Context.get(context, AgentRuntime)
			})

		const runtimeRef = yield* Ref.make(yield* provisionRuntime(agent.model, initialConfig.tools))
		const configRef = yield* Ref.make(initialConfig)
		const delegatingRuntime: AgentRuntimeService = {
			start: (input) => Ref.get(runtimeRef).pipe(Effect.flatMap((runtime) => runtime.start(input))),
			run: (input) => Ref.get(runtimeRef).pipe(Effect.flatMap((runtime) => runtime.run(input))),
			switchModel: (input) => Ref.get(runtimeRef).pipe(Effect.flatMap((runtime) => runtime.switchModel(input))),
		}

		const sessionContext = yield* Layer.buildWithMemoMap(
			liveSessionLayer.pipe(
				Layer.provide(Layer.mergeAll(sessionServicesLayer, Layer.succeed(AgentRuntime, delegatingRuntime))),
			),
			sessionMemoMap,
			sessionScope,
		)
		const session = Context.get(sessionContext, Session)
		const eventLog = Context.get(sessionServices, EventLog)

		const started = yield* session
			.start({
				cwd: options.cwd ?? null,
				model: agent.model.activeModel,
				systemPrompt: initialConfig.systemPrompt,
				meta: {
					...options.meta,
					...(agent.name === undefined ? {} : { agentName: agent.name }),
				},
			})
			.pipe(Effect.orDie)

		// Serialize sends and switches: a switch must not swap the provisioned runtime under a run that
		// is mid-flight, and the durable epoch entries must land before the next send projects them.
		const gate = yield* Semaphore.make(1)

		const send = (text: string): Effect.Effect<AgentFinishedLogEntry> =>
			gate.withPermit(session.send({ text }).pipe(Effect.orDie))

		const switchModel = (model: TartModel, switchOptions?: SwitchModelOptions): Effect.Effect<void> =>
			gate.withPermit(
				Effect.gen(function* () {
					const current = yield* Ref.get(configRef)
					const next: SessionAgentConfig = {
						systemPrompt: switchOptions?.systemPrompt ?? current.systemPrompt,
						tools: switchOptions?.tools ?? current.tools,
					}
					yield* validateToolNames(next.tools)

					// Provision against the new toolset before writing the transition, so the durable
					// tools-change below resolves over the newly installed tools. Nothing can run in
					// between: sends wait on the same gate.
					yield* Ref.set(runtimeRef, yield* provisionRuntime(model, next.tools))
					yield* session
						.switchModel({
							model: model.activeModel,
							systemPrompt: next.systemPrompt,
							reason: switchOptions?.reason ?? null,
						})
						.pipe(Effect.orDie)
					yield* Ref.set(configRef, next)
				}),
			)

		return {
			sessionId: started.sessionId,
			rootAgentId: started.rootAgentId,
			send,
			switchModel,
			events: (fromSeq?: LogSeq) => session.events(fromSeq),
			entries: Stream.runCollect(eventLog.entries()).pipe(Effect.orDie),
			interrupt: session.interrupt,
		}
	})
