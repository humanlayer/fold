/**
 * This file implements `startSession` and `resumeSession` - the ergonomic composition roots of the
 * public API. Callers describe an agent (model, prompt, tools, hooks) and optionally an event log
 * backend; this file lowers those descriptors into the internal service graph (EventLog, Ids,
 * AgentEvents, SystemPrompt, ModelRequestSettings, SessionControls, SessionAgents, and
 * per-provision Toolset + resolver + HookRunner + ToolRuntime + AgentRuntime, plus the Session facade)
 * and returns a running session handle. Per the composition-root ruling, this is the only place
 * descriptors become layers; no public signature accepts or returns one.
 *
 * System tools are ordinary members of `tools` (round-five ruling): the composition root walks tools
 * arrays from the root through every delegation tool's specialist and fork definitions, builds the
 * flat agent-definition registry, and runs each distinct tool value's `init` exactly once (the
 * skill tool's roster scan), collecting the realized tool and its leading-prompt block for every agent
 * listing that value.
 *
 * Session control (slice 2, D8/D9/D10): every run executes on a fiber the facade forks and registers
 * in SessionControls, so `interrupt` cancels the live fiber tree (uninterruptible finalizers write the
 * durable markers - the root's `agent-finished{interrupted}` here, subagent markers in the Subagents
 * engine, partial assistant text in the loop), `stop` raises the session-wide graceful-stop signal
 * every agent's loop observes at its batch boundaries, `steer` queues onto a running agent's steering
 * queue (drained between its turns), and `send` targets any agent - queueing a follow-up when the
 * target is running, continuing a finished subagent directly otherwise.
 *
 * Resume (slice 2): `resumeSession` ADOPTS an existing log - no new `session_started`/`agent_started`
 * rows; identity is recovered from the replayed `session_started`, and when the provided configuration
 * differs from the log's projected state (model binding - D17 ruling - or the composed leading blocks,
 * e.g. a changed skills roster - D20 rule), the facade writes one epoch transition before the first
 * send.
 */
import {
	Array as Arr,
	Predicate,
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	Layer,
	Match,
	Ref,
	Schema,
	Scope,
	Semaphore,
	Stream,
	Struct,
} from 'effect'
import { Prompt } from 'effect/ai'

import { toolEventSinkLayerFromAgentEvents, liveAgentEventsLayer } from '../AgentEvents/AgentEventsLayer'
import type { FoldEvent } from '../AgentEvents/AgentEventsService'
import { AgentRuntime, type AgentRuntimeService } from '../AgentRuntime/AgentRuntimeService'
import {
	CompactionArchiveAccess,
	noopCompactionArchiveAccess,
	type CompactionArchiveAccessService,
} from '../Compaction/CompactionArchiveAccess'
import { layerInMemoryEventLogWithIds } from '../EventLog/EventLogLayerMemory'
import { EventLog, type EventLogService } from '../EventLog/EventLogService'
import {
	ActiveModel,
	LogEntryInputs,
	type AgentFinishedLogEntry,
	type AssistantMessageLogEntry,
	type CompactionLogEntry,
	type LogEntry,
	type LogSeq,
	type ToolResultLogEntry,
} from '../EventLog/Schemas'
import { Ids, layerLiveIdFactory, type AgentId, type IdsService, type SessionId } from '../Ids'
import { ModelCatalog, modelCatalogFromEntries, type ModelCatalogEntry } from '../Model/ModelCatalog'
import { liveModelRequestSettingsLayer } from '../Model/ModelRequestSettings'
import { runtimeForAgent } from '../Projection/Projection'
import { AgentNotRunningError } from '../Session/Errors'
import {
	isProfileRole,
	layerProfiles,
	profileModelFor,
	Profiles,
	type ProfileRole,
	type ProfilesService,
	type SessionProfiles,
} from '../Session/Profiles'
import {
	layerSessionControls,
	SessionControls,
	type SessionControlsService,
	type SteeringMode,
} from '../Session/SessionControls'
import { liveSessionLayer } from '../Session/SessionLayer'
import { Session, type SessionService, type StartedSession } from '../Session/SessionService'
import type { SkillSourceService } from '../Skills/SkillSource'
import { StopConditions } from '../StopConditions/StopConditions'
import { agentIdsFromEntries, resolveAgentIdRef } from '../Subagents/AgentIdRef'
import {
	agentRegistryFromDefinitions,
	collectAgentDefinitions,
	type CollectedAgentDefinitions,
} from '../Subagents/AgentRegistry'
import { type SubagentBusyError, SubagentNotFoundError } from '../Subagents/Errors'
import { SessionAgents, type RealizedAgentTools, type RootAgentSnapshot } from '../Subagents/SessionAgents'
import { continueSubagent, type ContinueSubagentInput } from '../Subagents/SubagentEngine'
import { layerSystemPrompt } from '../SystemPrompt/SystemPromptLayer'
import { SystemPrompt, type SystemPromptService } from '../SystemPrompt/SystemPromptService'
import { systemPromptBlocks, type AgentDefinition, type SystemPromptInput } from './AgentDefinition'
import { memoryEventLog, type FoldEventLog } from './EventLogDescriptor'
import type { FoldModel } from './ModelDescriptor'
import { provisionAgentRuntime, validateToolNames } from './Provisioning'
import type { RealizedFoldTool, SessionToolContribution, FoldTool } from './ToolDefinition'

/**
 * Options for {@link startSession}. `RA` is the host services the agent (its model and tools) needs, `RL`
 * the ones the log backend needs, and `RP` the ones the profile models need; the session requires all
 * of them from its caller.
 */
export type StartSessionOptions<RA = never, RL = never, RP = never> = {
	readonly agent: AgentDefinition<RA>
	/** Event log backend for the session. Defaults to in-memory. */
	readonly log?: FoldEventLog<RL>
	/** Host working directory recorded on `session_started`; omit on hosts without a filesystem. */
	readonly cwd?: string
	readonly meta?: Readonly<Record<string, Schema.Json>>
	/**
	 * Pre-minted session id, for hosts that name the log location by session id (D5 layout). Defaults
	 * to a freshly minted id.
	 */
	readonly sessionId?: SessionId
	/** How queued steering messages drain at a turn boundary (D8). Defaults to one-at-a-time. */
	readonly steering?: SteeringMode
	/**
	 * Initial role->model bindings for role-bound subagent types (profiles slice). Must cover every
	 * role the roster names (`orchestrator` falls back to `smart`, D25); optional when every subagent
	 * binds a concrete model. Rebind mid-session with {@link FoldSession.setProfile}.
	 */
	readonly profiles?: SessionProfiles<RP>
	/**
	 * Model catalog entries installed session-wide (D15): compaction resolves context windows through
	 * them, and future consumers (cost projection, pickers) share the same data. Omitted means the
	 * empty catalog - every consumer falls back to its interim defaults.
	 */
	readonly catalog?: ReadonlyArray<ModelCatalogEntry>
	/** Optional host-provided archive/log access guidance appended after compaction summaries. */
	readonly compactionArchiveAccess?: CompactionArchiveAccessService
}

/** Options for {@link resumeSession}: the same agent configuration, over an existing log. */
export type ResumeSessionOptions<RA = never, RL = never, RP = never> = {
	readonly agent: AgentDefinition<RA>
	/** The existing event log to adopt; the session continues exactly where the log left off. */
	readonly log: FoldEventLog<RL>
	/** How queued steering messages drain at a turn boundary (D8). Defaults to one-at-a-time. */
	readonly steering?: SteeringMode
	/**
	 * Initial role->model bindings for role-bound subagent types (profiles slice). Must cover every
	 * role the roster names (`orchestrator` falls back to `smart`, D25); optional when every subagent
	 * binds a concrete model. Rebind mid-session with {@link FoldSession.setProfile}.
	 */
	readonly profiles?: SessionProfiles<RP>
	/**
	 * Model catalog entries installed session-wide (D15): compaction resolves context windows through
	 * them, and future consumers (cost projection, pickers) share the same data. Omitted means the
	 * empty catalog - every consumer falls back to its interim defaults.
	 */
	readonly catalog?: ReadonlyArray<ModelCatalogEntry>
	/** Optional host-provided archive/log access guidance appended after compaction summaries. */
	readonly compactionArchiveAccess?: CompactionArchiveAccessService
}

/** Options for {@link FoldSession.switchModel}. Omitted fields keep the session's current configuration. */
export type SwitchModelOptions<R = never> = {
	readonly reason?: string
	/** Replace the agent's own leading prompt blocks from this epoch on. */
	readonly systemPrompt?: SystemPromptInput
	/** Replace the installed tools from this epoch on. They may need only services the session already has. */
	readonly tools?: ReadonlyArray<FoldTool<R>>
	/**
	 * Atomically replace the complete role-to-model map in the same commit as this root epoch switch.
	 * Candidate subagent types are validated against this map; it is published only after the durable
	 * transition succeeds. Omitted means preserve the current bindings.
	 */
	readonly profiles?: SessionProfiles<R>
}

/**
 * Target selector shared by `send`, `steer`, and `interrupt`; omitted means the root agent. The target
 * may be a full agent id or a unique short reference like `agent_ab12cd34` (the form rendered in
 * subagent results and CLI lines); references resolve against the log's `agent_started` rows before
 * touching the run controls, which stay keyed by full ids.
 */
export type AgentTargetOptions = {
	readonly agentId?: AgentId | string
}

export type CompactOptions = {
	readonly additionalInstructions?: string | null
}

export type InjectedSkillEntries = {
	readonly call: AssistantMessageLogEntry
	readonly result: ToolResultLogEntry
}

/**
 * A running fold session: one durable log, one root agent, already started (or adopted). Every method
 * is safe to call without further wiring; root runs and `switchModel` are serialized against each
 * other so a switch cannot interleave with an in-flight root run. `R` is the host services the session
 * was started with; tools installed by a later switch may use them.
 */
export type FoldSession<R = never> = {
	readonly sessionId: SessionId
	readonly rootAgentId: AgentId
	/**
	 * Run one user turn on the target agent (root by default) and resolve with the durable
	 * `agent-finished` entry. When the target is already running, the message queues as a follow-up and
	 * joins that run at its natural completion boundary (D8); if the run ends without consuming it, a
	 * fresh run starts for it. Targeting a finished subagent by id continues that agent's loop directly
	 * (rows carry a null toolCallId - no tool dispatch caused them).
	 */
	readonly send: (
		text: string,
		options?: AgentTargetOptions,
	) => Effect.Effect<AgentFinishedLogEntry, SubagentNotFoundError>
	/**
	 * Queue a steering message for a RUNNING agent (root by default). It drains between that agent's
	 * turns - after the current tool batch, before the next model call - and is logged as an ordinary
	 * user-message exactly at that point (D8). Steering an idle agent fails with AgentNotRunningError.
	 */
	readonly steer: (text: string, options?: AgentTargetOptions) => Effect.Effect<void, AgentNotRunningError>
	/** Append a matched synthetic skill tool call/result pair to the target agent's durable context. */
	readonly injectSkill: (
		name: string,
		content: string,
		options?: AgentTargetOptions,
	) => Effect.Effect<InjectedSkillEntries, SubagentNotFoundError>
	/**
	 * Request a session-wide graceful stop (D9): every running agent finishes its in-flight tool batch,
	 * appends the results, and ends its run with `agent-finished{stopped}` - no further model calls.
	 * The signal clears when the next send begins.
	 */
	readonly stop: (reason?: string) => Effect.Effect<void>
	/**
	 * Hard interrupt (D10). With no target, cancels every running agent's fiber tree (in-flight
	 * inference, tools, hooks, and subagents); uninterruptible finalizers write the durable markers -
	 * partial assistant text, interrupted tool results, subagent markers, and the terminal
	 * `agent-finished{interrupted}` - so resume sees coherent, honest history. With a target agentId,
	 * interrupts just that agent's run (a dispatched subagent's interruption folds into its
	 * dispatcher's tool result; the dispatcher keeps running).
	 */
	readonly interrupt: (options?: AgentTargetOptions) => Effect.Effect<void>
	/**
	 * Switch the root agent to a different provider/model, optionally replacing its prompt blocks and
	 * installed tools in the same transition. Durably records the epoch transition - `model-change`, the
	 * recomposed leading `system-message`, `tools-change` over the (possibly new) installed toolset, and
	 * `thinking-change` when the reasoning level changed - and provisions the new configuration for every
	 * subsequent send. The same log continues across the switch.
	 */
	readonly switchModel: (model: FoldModel<R>, options?: SwitchModelOptions<R>) => Effect.Effect<void>
	/** Force a root-agent compaction now. Returns null when there is nothing safe to summarize. */
	readonly compact: (options?: CompactOptions) => Effect.Effect<CompactionLogEntry | null>
	/**
	 * Rebind one profile role to a different model (profiles slice). Role-bound subagent types resolve
	 * their binding at each dispatch/resume, so the swap applies from the very next run. No gating or
	 * serialization is involved: a dispatch racing a setProfile coherently gets either the old or the
	 * new binding, and running subagents finish on the model they started with - switches happen
	 * between runs. A later resume of a subagent that last ran pre-swap records the durable
	 * `model-change` transition. The ROOT agent's model is never profile-bound; switch it with
	 * {@link switchModel}.
	 */
	readonly setProfile: (role: ProfileRole, model: FoldModel<R>) => Effect.Effect<void>
	/** Merged stream of durable log rows and ephemeral streaming deltas. */
	readonly events: (fromSeq?: LogSeq) => Stream.Stream<FoldEvent>
	/** Snapshot of all durable log entries appended so far. */
	readonly entries: Effect.Effect<ReadonlyArray<LogEntry>>
	/** Append a generated title. The latest session_title row is authoritative. */
	readonly setTitle: (
		title: string,
		provenance?: { readonly generatedThroughSeq?: LogSeq; readonly rootUserTurns?: number },
	) => Effect.Effect<void>
}

/** The switchable slice of a session's configuration, tracked so omitted switch options carry forward. */
type SessionAgentConfig<R> = {
	readonly model: FoldModel<R>
	readonly promptCacheKey: string | null
	/** The agent's own leading blocks, normalized from its descriptor. */
	readonly systemPrompt: ReadonlyArray<string>
	readonly tools: ReadonlyArray<FoldTool<R>>
}

/** Lower the event log descriptor to its EventLog layer; the backend's own needs stay in the layer's `R`. */
const eventLogLayerFor = <R>(log: FoldEventLog<R>): Layer.Layer<EventLog, never, Ids | R> =>
	Match.valueTags(log, {
		memory: () => layerInMemoryEventLogWithIds,
		source: ({ make }) => Layer.effect(EventLog, make),
	})

/**
 * Run a tool's handler with the session's host services over whatever is in scope where the turn runs.
 * Effect AI merges the turn's services over the toolkit's, so a host whose request handling carries its
 * own FileSystem (Alchemy's Worker runtime provides Node's) would otherwise shadow the session's.
 */
const withHostServices = <R>(
	contribution: SessionToolContribution,
	hostServices: Context.Context<R>,
): SessionToolContribution => ({
	...contribution,
	handler: (params) =>
		// oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- the stored handler is erased by design
		contribution.handler(params).pipe(Effect.updateContext((context) => Context.merge(context, hostServices))),
})

const activeModelsEquivalent = Schema.toEquivalence(Schema.NullOr(ActiveModel))
const promptBlocksEquivalent = Schema.toEquivalence(Schema.Array(Schema.String))

/** Everything one assembled session shares between `startSession` and `resumeSession`. */
type SessionGraph<R> = {
	readonly agent: AgentDefinition<R>
	readonly session: SessionService
	readonly eventLog: EventLogService
	readonly ids: IdsService
	readonly controls: SessionControlsService
	readonly systemPromptService: SystemPromptService
	readonly continueSubagent: (
		input: ContinueSubagentInput,
	) => Effect.Effect<AgentFinishedLogEntry, SubagentNotFoundError | SubagentBusyError>
	readonly profiles: ProfilesService
	readonly configRef: Ref.Ref<SessionAgentConfig<R>>
	readonly validateSubagentRegistry: (
		definitions: CollectedAgentDefinitions<R>,
		profiles: SessionProfiles<unknown>,
	) => Effect.Effect<void>
	readonly extendSubagentRegistry: (definitions: CollectedAgentDefinitions<R>) => void
	readonly ensureToolContributions: (tools: ReadonlyArray<FoldTool<R>>) => Effect.Effect<void>
	readonly collectNewSubagentDefinitions: (
		tools: ReadonlyArray<FoldTool<R>>,
	) => Effect.Effect<CollectedAgentDefinitions<R>>
	readonly provisionRootRuntime: (
		model: FoldModel<R>,
		tools: ReadonlyArray<FoldTool<R>>,
	) => Effect.Effect<AgentRuntimeService>
	readonly setProvisionedRuntime: (runtime: AgentRuntimeService) => Effect.Effect<void>
	readonly currentProvisionedRuntime: Effect.Effect<AgentRuntimeService>
	readonly leadingPromptFor: (
		systemPrompt: ReadonlyArray<string>,
		tools: ReadonlyArray<FoldTool<unknown>>,
	) => ReadonlyArray<string> | null
}

/**
 * Assemble one session's whole service graph - registry, tool contributions, shared services,
 * controls, and the delegating root runtime - without writing anything
 * durable. `startSession` follows with `session.start`; `resumeSession` follows with adoption.
 */
const assembleSessionGraph = <R>(options: {
	readonly agent: AgentDefinition<R>
	readonly log?: FoldEventLog<R>
	readonly steering?: SteeringMode
	readonly profiles?: SessionProfiles<R>
	readonly catalog?: ReadonlyArray<ModelCatalogEntry>
	readonly compactionArchiveAccess?: CompactionArchiveAccessService
}): Effect.Effect<SessionGraph<R>, never, Scope.Scope | R> =>
	Effect.gen(function* () {
		const agent = options.agent
		// The host services every tool and the log backend need, taken once from the caller - the way Effect
		// AI's Toolkit hands its build context to handlers. Tools run later on the session's own fibers
		// (including tools installed by a later switch), so the session carries these for them.
		const hostServices = yield* Effect.context<R>()
		const rootTools = agent.tools ?? []
		const rootHooks = agent.hooks ?? {}

		// Walk the tools arrays from the root: every delegation tool contributes its specialist and fork
		// definitions recursively, flattening them into the session's registries (§1a).
		const agentDefinitions = yield* collectAgentDefinitions(rootTools)
		const subagentDefinitions = agentDefinitions.subagents
		const registry = agentRegistryFromDefinitions(agentDefinitions)

		// Profiles slice: every role-bound registry entry must resolve against the INITIAL bindings
		// (`orchestrator` -> `smart` fallback counts, D25), so an uncovered role is a configuration
		// defect at session start, never a dispatch-time surprise. Rosters binding only concrete
		// models need no profiles at all.
		const initialProfiles = options.profiles ?? {}
		for (const entry of registry.entries) {
			if (!isProfileRole(entry.model)) continue
			if (profileModelFor(initialProfiles, entry.model) !== undefined) continue
			const needed =
				entry.model === 'orchestrator' ? 'profiles.orchestrator (or profiles.smart)' : `profiles.${entry.model}`
			return yield* Effect.die(
				new Error(
					`subagent type "${entry.name}" binds model role "${entry.model}", but the session has no ` +
						`covering binding: pass ${needed} to startSession/resumeSession`,
				),
			)
		}

		// Per-agent tool-name validation - deliberately no session-global name map, so distinct
		// skillTool/subagentTool values never collide on their shared names across agents.
		yield* validateToolNames(rootTools)
		yield* Effect.forEach(subagentDefinitions, (definition) => validateToolNames(definition.tools ?? []), {
			discard: true,
		})
		yield* Effect.forEach(agentDefinitions.forkAgents, (definition) => validateToolNames(definition.tools), {
			discard: true,
		})

		// Run each distinct tool value's init exactly once per session (for ordinary tools that is a
		// constant; for the skill tool it is the roster scan): the contribution - realized tool,
		// leading-prompt block, skill source - is reused by every agent listing that value, across
		// epochs, and by every subagent dispatch (D20's one-snapshot law).
		// Tool inits may acquire services (a tool's own layer); they live as long as the session, including
		// tools first introduced by a later agent switch.
		const sessionScope = yield* Effect.scope
		const toolContributions = new Map<FoldTool<unknown>, SessionToolContribution>()
		const ensureToolContributions = (tools: ReadonlyArray<FoldTool<R>>): Effect.Effect<void> =>
			Effect.forEach(
				tools.filter((tool) => !toolContributions.has(tool)),
				(tool) =>
					tool.init.pipe(
						Effect.provideContext(hostServices),
						Scope.provide(sessionScope),
						Effect.map((contribution) =>
							toolContributions.set(tool, withHostServices(contribution, hostServices)),
						),
					),
				{ discard: true },
			).pipe(Effect.asVoid)

		yield* ensureToolContributions(rootTools)
		yield* Effect.forEach(subagentDefinitions, (definition) => ensureToolContributions(definition.tools ?? []), {
			discard: true,
		})
		yield* Effect.forEach(agentDefinitions.forkAgents, (definition) => ensureToolContributions(definition.tools), {
			discard: true,
		})

		/** Realize one agent's configured tools against the session-start contributions (§2.5). */
		const realizeAgentTools = (tools: ReadonlyArray<FoldTool<unknown>>): RealizedAgentTools => {
			const realized: Array<RealizedFoldTool> = []
			const promptBlocks: Array<string> = []
			let skillSource: SkillSourceService | null = null

			for (const tool of tools) {
				const contribution = toolContributions.get(tool)
				if (contribution === undefined) {
					// Invariant: every reachable tool value ran its init above (or at switch time).
					throw new Error(`tool "${tool.name}" was never initialized for this session`)
				}

				realized.push({ name: tool.name, tool: contribution.tool, handler: contribution.handler })
				if (contribution.promptBlock !== null) promptBlocks.push(contribution.promptBlock)
				if (contribution.skillSource !== undefined && skillSource === null) {
					skillSource = contribution.skillSource
				}
			}

			return { tools: realized, promptBlocks, skillSource }
		}

		/** One agent's leading blocks: its own, then its tools' contributed blocks (skills block, D20). */
		const leadingPromptFor = (
			systemPrompt: ReadonlyArray<string>,
			tools: ReadonlyArray<FoldTool<unknown>>,
		): ReadonlyArray<string> | null => {
			const blocks = [...systemPrompt, ...realizeAgentTools(tools).promptBlocks]
			return Arr.isArrayEmpty(blocks) ? null : blocks
		}

		const initialConfig: SessionAgentConfig<R> = {
			model: agent.model,
			promptCacheKey: agent.promptCacheKey ?? null,
			systemPrompt: systemPromptBlocks(agent.systemPrompt),
			tools: rootTools,
		}

		const configRef = yield* Ref.make(initialConfig)
		const currentRootAgent: Effect.Effect<RootAgentSnapshot> = Ref.get(configRef).pipe(
			Effect.map((config) => ({
				model: config.model,
				promptCacheKey: config.promptCacheKey,
				tools: config.tools,
				hooks: rootHooks,
				systemPrompt: config.systemPrompt,
			})),
		)

		// One shared service graph per session; every provisioned runtime runs inside these same
		// instances (one EventLog, one Ids source, one AgentEvents PubSub, one SessionControls). HookRunner is deliberately NOT session-fixed: each provisioned runtime
		// carries its own agent's hook chains (D16/D21). Tool handlers get their declared platform
		// services from this graph too: Effect AI hands each handler the context its toolkit was built in.
		const idsLayer = layerLiveIdFactory
		const infraLayer = Layer.mergeAll(
			eventLogLayerFor(options.log ?? memoryEventLog()).pipe(Layer.provide(idsLayer)),
			idsLayer,
			liveAgentEventsLayer,
		)
		const servicesLayer = Layer.mergeAll(
			infraLayer,
			Layer.succeedContext(hostServices),
			layerSystemPrompt(agent.basePrompts === undefined ? {} : { basePrompts: agent.basePrompts }),
			liveModelRequestSettingsLayer,
			toolEventSinkLayerFromAgentEvents.pipe(Layer.provide(infraLayer)),
			// How this session builds agents: the subagent operations and every provision read it.
			Layer.succeed(SessionAgents, {
				registry,
				realizeTools: realizeAgentTools,
				currentRoot: currentRootAgent,
				// Session-wide auto-compaction policy (D11): every provisioned runtime - root and subagent -
				// shares it while checking its own projection and summarizing with its own model.
				autoCompact: agent.autoCompact,
			}),
			Layer.succeed(CompactionArchiveAccess, options.compactionArchiveAccess ?? noopCompactionArchiveAccess),
			// Session-wide model catalog (D15): compaction resolves context windows through it. Omitted
			// entries build the empty catalog, which behaves exactly like the Reference default.
			Layer.succeed(ModelCatalog, modelCatalogFromEntries(options.catalog ?? [])),
			Layer.succeed(StopConditions, agent.stopConditions ?? {}),
			layerSessionControls(options.steering === undefined ? {} : { steeringMode: options.steering }),
			// Session-wide role->model bindings (profiles slice): one mutable map shared by the facade's
			// setProfile and the subagent operations' per-dispatch/resume resolution.
			layerProfiles(initialProfiles),
		)
		// Builds use session-fresh memo maps, never the ambient CurrentMemoMap: layers are memoized by
		// reference per memo map, and under `Effect.provide` (any app or test harness) the ambient map
		// would share module-level layers - the event log, the event spine - across sessions, and hand
		// every model switch the previous epoch's memoized runtime.
		const sessionMemoMap = yield* Layer.makeMemoMap
		const sessionServices = yield* Layer.buildWithMemoMap(servicesLayer, sessionMemoMap, sessionScope).pipe(
			Effect.orDie,
		)
		const sessionServicesLayer = Layer.succeedContext(sessionServices)

		// Provision one runtime slice per epoch: the installed Toolset, its family resolver, the root's
		// HookRunner, the ToolRuntime executing against it, and the AgentRuntime bound to the model's
		// provider (Provisioning.ts owns the fresh-memo-map and ambient-scope invariants). The delegating
		// runtime below lets the Session service survive swaps (interim AgentModels seam - D15). Root
		// provisions target the session scope explicitly: switchModel runs later, from the caller's own
		// scope, and the provisioned provider client must outlive that caller. The session handle is the
		// edge where host code calls in with nothing around it, so it runs these inside the session's
		// services.
		const provisionRootRuntime = (
			model: FoldModel<R>,
			tools: ReadonlyArray<FoldTool<R>>,
		): Effect.Effect<AgentRuntimeService> =>
			provisionAgentRuntime({ model, tools: realizeAgentTools(tools).tools, hooks: rootHooks }).pipe(
				Scope.provide(sessionScope),
				Effect.provideContext(sessionServices),
			)

		const runtimeRef = yield* Ref.make(yield* provisionRootRuntime(agent.model, rootTools))
		const delegatingRuntime: AgentRuntimeService = {
			start: (input) => Ref.get(runtimeRef).pipe(Effect.flatMap((runtime) => runtime.start(input))),
			run: (input) => Ref.get(runtimeRef).pipe(Effect.flatMap((runtime) => runtime.run(input))),
			switchModel: (input) => Ref.get(runtimeRef).pipe(Effect.flatMap((runtime) => runtime.switchModel(input))),
			compact: (input) => Ref.get(runtimeRef).pipe(Effect.flatMap((runtime) => runtime.compact(input))),
		}

		const sessionContext = yield* Layer.buildWithMemoMap(
			liveSessionLayer.pipe(
				Layer.provide(Layer.mergeAll(sessionServicesLayer, Layer.succeed(AgentRuntime, delegatingRuntime))),
			),
			sessionMemoMap,
			sessionScope,
		)

		return {
			agent,
			session: Context.get(sessionContext, Session),
			eventLog: Context.get(sessionServices, EventLog),
			ids: Context.get(sessionServices, Ids),
			controls: Context.get(sessionServices, SessionControls),
			systemPromptService: Context.get(sessionServices, SystemPrompt),
			continueSubagent: (input) => continueSubagent(input).pipe(Effect.provideContext(sessionServices)),
			profiles: Context.get(sessionServices, Profiles),
			configRef,
			validateSubagentRegistry: (definitions, candidateProfiles) =>
				Effect.sync(() => {
					const bindings = [
						...registry.entries,
						...definitions.subagents.filter(
							(definition) => registry.resolveAgentType(definition.name) === null,
						),
					]
					for (const entry of bindings) {
						if (!isProfileRole(entry.model)) continue
						if (profileModelFor(candidateProfiles, entry.model) !== undefined) continue
						throw new Error(
							`subagent type "${entry.name}" binds model role "${entry.model}", but the session has no covering profile binding`,
						)
					}
				}),
			extendSubagentRegistry: (definitions) => {
				registry.extend(definitions)
			},
			ensureToolContributions,
			collectNewSubagentDefinitions: (tools) => collectAgentDefinitions(tools),
			provisionRootRuntime,
			setProvisionedRuntime: (runtime) => Ref.set(runtimeRef, runtime),
			currentProvisionedRuntime: Ref.get(runtimeRef),
			leadingPromptFor,
		}
	})

/** Build the public handle over one assembled, started-or-adopted session. */
const makeSessionHandle = <R>(graph: SessionGraph<R>, identity: StartedSession): FoldSession<R> => {
	const { session, eventLog, ids, controls, continueSubagent, configRef, profiles } = graph
	const rootAgentId = identity.rootAgentId

	const collectEntries: Effect.Effect<ReadonlyArray<LogEntry>> = Stream.runCollect(eventLog.entries()).pipe(
		Effect.orDie,
		Effect.map((entries): ReadonlyArray<LogEntry> => entries),
	)

	/**
	 * Resolve a caller-supplied target reference (full id or unique short prefix, D8 targeting) to the
	 * full agent id the controls and engine are keyed by. Ambiguous references fail as not-found
	 * carrying the candidate short ids.
	 */
	const resolveTarget = (ref: AgentId | string): Effect.Effect<AgentId, SubagentNotFoundError> =>
		collectEntries.pipe(
			Effect.flatMap((entries) => {
				const resolution = resolveAgentIdRef(agentIdsFromEntries(entries), ref)
				return Match.valueTags(resolution, {
					resolved: ({ agentId }) => Effect.succeed(agentId),
					'not-found': () => Effect.fail(new SubagentNotFoundError({ requested: ref })),
					ambiguous: ({ candidates }) =>
						Effect.fail(new SubagentNotFoundError({ requested: ref, candidates })),
				})
			}),
		)

	/** The last durable terminal marker for one agent; interrupt paths read the finalizer-written row. */
	const lastFinishedFor = (agentId: AgentId): Effect.Effect<AgentFinishedLogEntry> =>
		collectEntries.pipe(
			Effect.flatMap((entries) => {
				const finished = entries.findLast(
					(entry): entry is AgentFinishedLogEntry =>
						Predicate.isTagged(entry, 'agent-finished') && entry.agentId === agentId,
				)
				return finished === undefined
					? Effect.die(new Error(`agent ${agentId} has no terminal marker after its run ended`))
					: Effect.succeed(finished)
			}),
		)

	/**
	 * Uninterruptible exit marker for an interrupted root run (D10): the terminal
	 * `agent-finished{interrupted}` row, seq-guarded because the root's runs all share the null
	 * toolCallId envelope. Non-interrupt failures write nothing here - the loop already wrote its own
	 * durable outcome (provider errors) or the defect propagates unchanged.
	 */
	const writeRootInterruptMarker =
		(baselineSeq: LogSeq) =>
		(exit: Exit.Exit<AgentFinishedLogEntry>): Effect.Effect<void> =>
			Effect.gen(function* () {
				if (Exit.isSuccess(exit) || !Cause.hasInterrupts(exit.cause)) return

				const entries = yield* collectEntries
				const finishedThisRun = entries.some(
					(entry) =>
						Predicate.isTagged(entry, 'agent-finished') &&
						entry.agentId === rootAgentId &&
						entry.seq > baselineSeq,
				)
				if (finishedThisRun) return

				yield* eventLog
					.append(
						LogEntryInputs['agent-finished']({
							agentId: rootAgentId,
							parentAgentId: null,
							toolCallId: null,
							outcome: 'interrupted',
							resultText: null,
							reason: 'interrupted by the user',
						}),
					)
					.pipe(Effect.orDie, Effect.asVoid)
			})

	// Serialize root runs and switches: a switch must not swap the provisioned runtime under a run that
	// is mid-flight, and the durable epoch entries must land before the next send projects them.
	const gate = Semaphore.makeUnsafe(1)

	/** One root run on a registered fiber: interruptible externally, honest markers on teardown. */
	const runRootSend = (text: string): Effect.Effect<AgentFinishedLogEntry> =>
		gate.withPermit(
			Effect.gen(function* () {
				// A new send clears a previous graceful-stop request (D9): stop targets current work.
				yield* controls.clearSessionStop

				const claimed = yield* controls.claimRunning(rootAgentId)
				if (!claimed) {
					return yield* Effect.die(new Error('root agent already running while the send gate was held'))
				}

				const entries = yield* collectEntries
				const baselineSeq = entries.at(-1)?.seq
				if (baselineSeq === undefined) {
					return yield* Effect.die(new Error('send on an empty session log'))
				}

				const runFiber = yield* Effect.forkChild(
					session
						.send({ text })
						.pipe(
							Effect.orDie,
							Effect.onExit(writeRootInterruptMarker(baselineSeq)),
							Effect.ensuring(controls.releaseRunning(rootAgentId)),
						),
				)
				yield* controls.setRunningFiber(rootAgentId, runFiber)

				const exit = yield* Fiber.await(runFiber)
				if (Exit.isSuccess(exit)) return exit.value
				if (Cause.hasInterrupts(exit.cause)) {
					// The marker finalizer already wrote the durable interrupted outcome; return it.
					return yield* lastFinishedFor(rootAgentId)
				}
				return yield* Effect.failCause(exit.cause)
			}),
		)

	const send = (
		text: string,
		options?: AgentTargetOptions,
	): Effect.Effect<AgentFinishedLogEntry, SubagentNotFoundError> =>
		Effect.gen(function* () {
			const target = options?.agentId === undefined ? rootAgentId : yield* resolveTarget(options.agentId)

			// D8: a running target gets the message as a follow-up that joins its current run at the
			// natural completion boundary. If that run ends without consuming it (stopped, errored, or
			// interrupted first), send still means "this message gets a run" - start one below.
			if (yield* controls.isRunning(target)) {
				const ticket = yield* controls
					.pushFollowUp(target, text)
					.pipe(Effect.catchTag('AgentNotRunningError', () => Effect.succeed(null)))

				if (ticket !== null) {
					const consumed = yield* ticket.consumed
					if (consumed) {
						const exit = yield* controls.awaitRunning(target)
						if (exit !== null && Exit.isSuccess(exit)) return exit.value
						return yield* lastFinishedFor(target)
					}
					return yield* send(text, options)
				}
			}

			if (target === rootAgentId) {
				return yield* runRootSend(text)
			}

			// A finished subagent continues directly (D8): null toolCallId - no tool dispatch caused it.
			return yield* continueSubagent({ agentId: target, prompt: text }).pipe(
				Effect.catchTag('SubagentBusyError', () => send(text, options)),
			)
		})

	const steer = (text: string, options?: AgentTargetOptions): Effect.Effect<void, AgentNotRunningError> =>
		options?.agentId === undefined
			? controls.steer(rootAgentId, text)
			: resolveTarget(options.agentId).pipe(
					Effect.catchTag('SubagentNotFoundError', (error) =>
						Effect.fail(
							new AgentNotRunningError({
								agentId: error.requested,
								message:
									error.candidates === undefined
										? `No agent matches "${error.requested}" in this session, so there is nothing to steer.`
										: `"${error.requested}" is ambiguous: it matches ${error.candidates.length} agents ` +
											`(${[...new Set(error.candidates)].join(', ')}). Provide more characters of the agent id.`,
							}),
						),
					),
					Effect.flatMap((target) => controls.steer(target, text)),
				)

	const encodeAssistantMessage = Schema.encodeUnknownSync(Prompt.AssistantMessage)
	const encodeToolMessage = Schema.encodeUnknownSync(Prompt.ToolMessage)
	const injectSkill = (
		name: string,
		content: string,
		options?: AgentTargetOptions,
	): Effect.Effect<InjectedSkillEntries, SubagentNotFoundError> =>
		Effect.gen(function* () {
			const target = options?.agentId === undefined ? rootAgentId : yield* resolveTarget(options.agentId)
			const toolCallId = yield* ids.makeToolCallId
			const call = yield* eventLog
				.append(
					LogEntryInputs['assistant-message']({
						agentId: target,
						parentAgentId: null,
						toolCallId: null,
						messageId: yield* ids.makeMessageId,
						message: encodeAssistantMessage(
							Prompt.assistantMessage({
								content: [
									Prompt.toolCallPart({
										id: toolCallId,
										name: 'skill',
										params: { name },
										providerExecuted: false,
									}),
								],
							}),
						),
						finish: null,
					}),
				)
				.pipe(Effect.orDie)
			if (!Predicate.isTagged(call, 'assistant-message')) {
				return yield* Effect.die(new Error(`EventLog returned ${call._tag} while injecting skill call`))
			}

			const result = yield* eventLog
				.append(
					LogEntryInputs['tool-result']({
						agentId: target,
						parentAgentId: null,
						toolCallId,
						messageId: yield* ids.makeMessageId,
						message: encodeToolMessage(
							Prompt.toolMessage({
								content: [
									Prompt.toolResultPart({
										id: toolCallId,
										name: 'skill',
										result: { content },
										isFailure: false,
										providerExecuted: false,
									}),
								],
							}),
						),
						executedInput: { name },
					}),
				)
				.pipe(Effect.orDie)
			if (!Predicate.isTagged(result, 'tool-result')) {
				return yield* Effect.die(new Error(`EventLog returned ${result._tag} while injecting skill result`))
			}
			return { call, result }
		})

	const stop = (reason?: string): Effect.Effect<void> =>
		controls.requestSessionStop(reason ?? 'the user requested a stop')

	const interrupt = (options?: AgentTargetOptions): Effect.Effect<void> =>
		options?.agentId === undefined
			? controls.interruptAllRunning
			: resolveTarget(options.agentId).pipe(
					Effect.flatMap((target) => controls.interruptRunning(target)),
					// An unresolvable target is not running by definition - same no-op as an idle full id.
					Effect.catchTag('SubagentNotFoundError', () => Effect.succeed(false)),
					Effect.asVoid,
				)

	const switchModel = (model: FoldModel<R>, switchOptions?: SwitchModelOptions<R>): Effect.Effect<void> =>
		gate.withPermit(
			Effect.gen(function* () {
				const current = yield* Ref.get(configRef)
				const currentProfiles = yield* profiles.snapshot
				const candidateProfiles = switchOptions?.profiles ?? currentProfiles
				const next: SessionAgentConfig<R> = {
					model,
					promptCacheKey: current.promptCacheKey,
					systemPrompt:
						switchOptions?.systemPrompt === undefined
							? current.systemPrompt
							: systemPromptBlocks(switchOptions.systemPrompt),
					tools: switchOptions?.tools ?? current.tools,
				}
				yield* validateToolNames(next.tools)

				// A switch may introduce new session-initialized tools and subagent types. The switch gate
				// is the sole extension boundary, so dispatch can never observe a partially installed graph.
				yield* graph.ensureToolContributions(next.tools)
				const introduced = yield* graph.collectNewSubagentDefinitions(next.tools)
				yield* Effect.forEach(introduced.subagents, (definition) => validateToolNames(definition.tools ?? []), {
					discard: true,
				})
				yield* Effect.forEach(
					introduced.subagents,
					(definition) => graph.ensureToolContributions(definition.tools ?? []),
					{
						discard: true,
					},
				)
				yield* Effect.forEach(introduced.forkAgents, (definition) => validateToolNames(definition.tools), {
					discard: true,
				})
				yield* Effect.forEach(
					introduced.forkAgents,
					(definition) => graph.ensureToolContributions(definition.tools),
					{ discard: true },
				)
				yield* graph.validateSubagentRegistry(introduced, candidateProfiles)

				// Provision against the new toolset before writing the transition, so the durable
				// tools-change below resolves over the newly installed tools. Nothing can run in
				// between: root runs wait on the same gate.
				const nextRuntime = yield* graph.provisionRootRuntime(model, next.tools)
				const previousRuntime = yield* graph.currentProvisionedRuntime
				yield* graph.setProvisionedRuntime(nextRuntime)
				const transition = yield* session
					.switchModel({
						model: model.activeModel,
						systemPrompt: graph.leadingPromptFor(next.systemPrompt, next.tools),
						reason: switchOptions?.reason ?? null,
					})
					.pipe(Effect.orDie, Effect.exit)
				if (Exit.isFailure(transition)) {
					yield* graph.setProvisionedRuntime(previousRuntime)
					return yield* Effect.failCause(transition.cause)
				}
				graph.extendSubagentRegistry(introduced)
				yield* profiles.replace(candidateProfiles)
				yield* Ref.set(configRef, next)
			}),
		)

	const compact = (options?: CompactOptions): Effect.Effect<CompactionLogEntry | null> =>
		gate.withPermit(session.compact(options).pipe(Effect.orDie))

	// Deliberately un-gated (unlike switchModel): role bindings are read at dispatch/resume time, so a
	// racing dispatch coherently gets the old or the new binding and nothing mid-run ever rebinds.
	const setProfile = (role: ProfileRole, model: FoldModel<R>): Effect.Effect<void> => profiles.set(role, model)
	const setTitle: FoldSession['setTitle'] = (title, provenance) =>
		graph.eventLog
			.append(
				LogEntryInputs['session_title']({
					agentId: null,
					parentAgentId: null,
					toolCallId: null,
					title,
					...provenance,
				}),
			)
			.pipe(Effect.asVoid, Effect.orDie)

	return {
		sessionId: identity.sessionId,
		rootAgentId,
		send,
		steer,
		injectSkill,
		stop,
		interrupt,
		switchModel,
		compact,
		setProfile,
		events: (fromSeq?: LogSeq) => session.events(fromSeq),
		entries: collectEntries,
		setTitle,
	}
}

/**
 * Start one session for the given agent definition and return its running handle. The session lives in
 * the surrounding scope: closing the scope releases the log backend, event spine, and provisioned model
 * runtimes.
 */
export const startSession = <RA = never, RL = never, RP = never>(
	options: StartSessionOptions<RA, RL, RP>,
): Effect.Effect<FoldSession<RA | RL | RP>, never, Scope.Scope | RA | RL | RP> =>
	Effect.gen(function* () {
		const graph = yield* assembleSessionGraph<RA | RL | RP>(options)
		const config = yield* Ref.get(graph.configRef)
		const meta =
			options.agent.name === undefined ? { ...options.meta } : { ...options.meta, agentName: options.agent.name }
		const started = yield* graph.session
			.start({
				cwd: options.cwd ?? null,
				model: options.agent.model.activeModel,
				systemPrompt: graph.leadingPromptFor(config.systemPrompt, config.tools),
				meta,
				...Struct.pick(options.agent, ['promptCacheKey']),
				...Struct.pick(options, ['sessionId']),
			})
			.pipe(Effect.orDie)

		return makeSessionHandle(graph, started)
	})

/**
 * Resume an existing session log: ADOPT its identity (no new `session_started`/`agent_started` rows -
 * the replayed log is the state) and continue with the given agent configuration. When the projected
 * root state differs from the configuration - the model binding (D17 resume ruling) or the composed
 * leading blocks, e.g. a freshly scanned skills roster (D20 resume rule) - one durable epoch
 * transition is written before the first send.
 */
export const resumeSession = <RA = never, RL = never, RP = never>(
	options: ResumeSessionOptions<RA, RL, RP>,
): Effect.Effect<FoldSession<RA | RL | RP>, never, Scope.Scope | RA | RL | RP> =>
	Effect.gen(function* () {
		const graph = yield* assembleSessionGraph<RA | RL | RP>(options)
		const entries = yield* Stream.runCollect(graph.eventLog.entries()).pipe(
			Effect.orDie,
			Effect.map((collected): ReadonlyArray<LogEntry> => collected),
		)

		const sessionStarted = entries.find((entry) => Predicate.isTagged(entry, 'session_started'))
		if (sessionStarted === undefined || !Predicate.isTagged(sessionStarted, 'session_started')) {
			return yield* Effect.die(
				new Error('cannot resume: the log has no session_started row (use startSession for a fresh log)'),
			)
		}

		const identity: StartedSession = {
			sessionId: sessionStarted.sessionId,
			rootAgentId: sessionStarted.rootAgentId,
		}
		yield* graph.session.adopt(identity).pipe(Effect.orDie)

		// D17 resume ruling + D20 resume roster rule: one epoch transition iff the configuration no
		// longer matches the log's projected root state - the model binding, or the leading block set
		// the current configuration would compose (the skills roster was freshly scanned above; a
		// changed scan changes the composed blocks).
		const config = yield* Ref.get(graph.configRef)
		const projected = runtimeForAgent(entries, identity.rootAgentId)
		const composedBlocks = yield* graph.systemPromptService.compose({
			model: config.model.activeModel,
			agentBlocks: graph.leadingPromptFor(config.systemPrompt, config.tools) ?? [],
		})
		const loggedLeading = entries.findLast(
			(entry) =>
				Predicate.isTagged(entry, 'system-message') &&
				entry.agentId === identity.rootAgentId &&
				entry.placement === 'leading',
		)
		const loggedBlocks =
			loggedLeading !== undefined && Predicate.isTagged(loggedLeading, 'system-message')
				? loggedLeading.messages.map((message) => message.content)
				: []

		const modelDiffers = !activeModelsEquivalent(projected.activeModel, config.model.activeModel)
		const blocksDiffer = !promptBlocksEquivalent(composedBlocks, loggedBlocks)

		if (modelDiffers || blocksDiffer) {
			yield* graph.session
				.switchModel({
					model: config.model.activeModel,
					systemPrompt: graph.leadingPromptFor(config.systemPrompt, config.tools),
					reason: 'resume: the session configuration changed since this log was written',
				})
				.pipe(Effect.orDie)
		}

		return makeSessionHandle(graph, identity)
	})
