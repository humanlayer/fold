/**
 * This file implements `startSession` - the ergonomic composition root of the public API. Callers
 * describe an agent (model, prompt, tools, hooks) and optionally an event log backend; this file lowers
 * those descriptors into the internal service graph (EventLog, Ids, AgentEvents, Toolset + resolver,
 * SystemPrompt, ModelRequestSettings, HookRunner, ToolRuntime, AgentRuntime, Session) and returns a
 * running session handle. Per the composition-root ruling, this is the only place descriptors become
 * layers; no public signature accepts or returns one.
 *
 * Model switching: the AgentRuntime consumed by the Session is a delegating facade over a Ref of the
 * currently provisioned runtime. `TartSession.switchModel` first writes the durable D17 epoch transition
 * (`model-change`, recomposed leading `system-message`, `tools-change`) through the Session service, then
 * provisions a runtime for the new provider into the session scope and swaps the Ref - so the next send
 * runs on the new provider against the same durable log. This Ref is the interim form of the D15
 * AgentModels provisioning seam.
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
	 * Switch the root agent to a different provider/model. Durably records the D17 epoch transition
	 * (`model-change`, recomposed leading `system-message`, `tools-change`) and provisions the new
	 * provider for every subsequent send - the same log continues across the switch.
	 */
	readonly switchModel: (model: TartModel, options?: { readonly reason?: string }) => Effect.Effect<void>
	/** Merged stream of durable log rows and ephemeral streaming deltas. */
	readonly events: (fromSeq?: LogSeq) => Stream.Stream<TartEvent>
	/** Snapshot of all durable log entries appended so far. */
	readonly entries: Effect.Effect<ReadonlyArray<LogEntry>>
	readonly interrupt: Effect.Effect<void>
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

/** Assemble the agent's tool descriptors into the installed Toolset layer. */
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

/**
 * Start one session for the given agent definition and return its running handle. The session lives in
 * the surrounding scope: closing the scope releases the log backend, event spine, and provisioned model
 * runtimes.
 */
export const startSession = (options: StartSessionOptions): Effect.Effect<TartSession, never, Scope.Scope> =>
	Effect.gen(function* () {
		const agent = options.agent
		const tools = agent.tools ?? []

		const duplicateNames = [
			...new Set(tools.map((tool) => tool.name).filter((name, index, names) => names.indexOf(name) !== index)),
		]
		if (duplicateNames.length > 0) {
			return yield* Effect.die(new Error(`startSession: duplicate tool names: ${duplicateNames.join(', ')}`))
		}

		// One shared service graph per session; every provisioned model runtime closes over these same
		// instances (one EventLog, one AgentEvents PubSub, one Toolset).
		const infraLayer = Layer.mergeAll(
			eventLogLayerFor(options.log ?? { _tag: 'memory' }),
			layerLiveIdFactory,
			liveAgentEventsLayer,
		)
		const toolsetLayer = toolsetLayerFor(tools)
		const servicesLayer = Layer.mergeAll(
			infraLayer,
			toolsetLayer,
			makeToolsetResolver().pipe(Layer.provide(toolsetLayer)),
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
		const sessionServices = yield* Layer.buildWithMemoMap(
			liveToolRuntimeLayer.pipe(Layer.provideMerge(servicesLayer)),
			sessionMemoMap,
			sessionScope,
		).pipe(Effect.orDie)
		const sessionServicesLayer = Layer.succeedContext(sessionServices)

		// Provision one AgentRuntime per model into the session scope; the delegating runtime below lets
		// the Session service survive swaps (interim AgentModels seam - D15). Each provision builds with
		// its own memo map so the runtime layer rebuilds against the new model layer instead of hitting
		// the previous epoch's memoized instance.
		const provisionRuntime = (model: TartModel): Effect.Effect<AgentRuntimeService> =>
			Effect.gen(function* () {
				const memoMap = yield* Layer.makeMemoMap
				const context = yield* Layer.buildWithMemoMap(
					liveAgentRuntimeLayer.pipe(
						Layer.provide(Layer.mergeAll(sessionServicesLayer, languageModelLayerFor(model))),
					),
					memoMap,
					sessionScope,
				)

				return Context.get(context, AgentRuntime)
			})

		const runtimeRef = yield* Ref.make(yield* provisionRuntime(agent.model))
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
				systemPrompt: agent.systemPrompt ?? null,
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

		const switchModel = (model: TartModel, switchOptions?: { readonly reason?: string }): Effect.Effect<void> =>
			gate.withPermit(
				Effect.gen(function* () {
					yield* session
						.switchModel({
							model: model.activeModel,
							systemPrompt: agent.systemPrompt ?? null,
							reason: switchOptions?.reason ?? null,
						})
						.pipe(Effect.orDie)
					yield* Ref.set(runtimeRef, yield* provisionRuntime(model))
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
