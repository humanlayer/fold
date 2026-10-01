/**
 * This file implements the subagent operations (D21) - dispatch, fork, resume, and continue - the deep
 * module behind the subagent tool. It owns the whole choreography: roster guards, id minting,
 * per-dispatch runtime provisioning (own model, tools, hooks over the shared session services), the
 * durable agent_started/user-message writes via AgentRuntime, the subagent run fiber (forked into the
 * dispatch call's scope so interrupting the dispatcher structurally tears the subagent down), exit
 * folding (a subagent that errors, dies, or is interrupted is a RESULT, never a failure -
 * capture-then-narrow like the tool-settlement seam), the uninterruptible exit finalizers that keep the
 * log honest (interrupt/error markers + the InterruptNote naming the subagent id and turn count), skill
 * preload through the dispatcher's own skillTool source, and resume - including the D17 model transition
 * when the configured binding changed since the subagent last ran. Registry entries may bind their model
 * by profile role name (profiles slice): role bindings resolve through the session's Profiles map at
 * every consumption point - dispatch, and the origin snapshot feeding fork/resume/continue - so a
 * `setProfile` swap binds on the very next run and the existing transition diff sees only concrete
 * models.
 *
 * The operations are plain Effects that take the session's services from their surroundings. Dispatch,
 * fork, and resume run inside a tool call (the executing call's identity and interrupt note arrive as the
 * per-call CurrentAgent / CurrentToolCall / InterruptNote services), and the subagents they launch run
 * tools that may call them again. Continue runs from the session handle, with no tool call.
 */
import { Array as Arr, Data, Match, Predicate, Cause, Effect, Exit, Fiber, Ref, Schema, Stream } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import type { FoldModel } from '../Api/ModelDescriptor'
import { provisionAgentRuntime } from '../Api/Provisioning'
import type { RealizedFoldTool, FoldTool } from '../Api/ToolDefinition'
import { EventLog } from '../EventLog/EventLogService'
import { encodedContentText } from '../EventLog/MessageContent'
import {
	ActiveModel,
	LogEntryInputs,
	type AgentFinishedLogEntry,
	type AgentFork,
	type AgentLaunchMode,
	type AgentStartedLogEntry,
	type AssistantMessageLogEntry,
	type LogEntry,
	type LogEntryInput,
	type LogSeq,
} from '../EventLog/Schemas'
import type { HookConfig } from '../HookRunner/Types'
import { Ids, type AgentId, type ToolCallId } from '../Ids'
import { runtimeForAgent } from '../Projection/Projection'
import { isProfileRole, Profiles } from '../Session/Profiles'
import { SessionControls } from '../Session/SessionControls'
import { SkillNotFoundError } from '../Skills/SkillSource'
import { renderSkillContent } from '../Skills/SkillTool'
import { modelVisibleErrorDetailsFromCause } from '../ToolRuntime/ModelVisibleErrors'
import {
	CurrentAgent,
	CurrentToolCall,
	InterruptNote,
	type InterruptNoteService,
} from '../ToolRuntime/ToolContextServices'
import { agentIdsFromEntries, resolveAgentIdRef, shortAgentId } from './AgentIdRef'
import type { AgentRegistry, RegisteredAgentType } from './AgentRegistry'
import { SubagentBusyError, SubagentNotFoundError, SubagentTypeNotInRosterError } from './Errors'
import type { ForkSubagentInput, SubagentResult, TurnCount } from './Schemas'
import { SessionAgents, type RealizedAgentTools } from './SessionAgents'
import type { SubagentModelBinding } from './SubagentDefinition'

const encodeUserMessage = Schema.encodeUnknownSync(Prompt.UserMessage)

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

/** Input for dispatching one fresh subagent of a registered type. */
export type DispatchSubagentInput = {
	/** The requested agent type name. */
	readonly agent: string
	readonly prompt: string
	/** Skill to preload after the prompt, resolved through the dispatcher's own skillTool source. */
	readonly skill: string | null
	/** The executing subagentTool value's roster (from its closure) - the dispatch authority (§1a). */
	readonly allowedAgents: ReadonlyArray<string>
}

/**
 * Input for resuming a previously dispatched subagent by reference: the full branded id, or a unique
 * short prefix like `agent_ab12cd34` (the form rendered in subagent results). The reference resolves
 * against the log's `agent_started` rows - exact match first, then unique prefix.
 */
export type ResumeSubagentInput = {
	readonly agentId: AgentId | string
	readonly prompt: string
	readonly skill: string | null
}

/** Input for continuing a finished subagent directly from the SDK (D8 `send(message, { agentId })`). */
export type ContinueSubagentInput = {
	readonly agentId: AgentId
	readonly prompt: string
}

/** Where an agent's configuration comes from: a registered type, or the root agent. */
type OriginatingConfig = { readonly _tag: 'entry'; readonly entry: RegisteredAgentType } | { readonly _tag: 'root' }
const OriginatingConfig = Data.taggedEnum<OriginatingConfig>()

type AgentConfigurationSnapshot = {
	readonly model: FoldModel<unknown>
	readonly promptCacheKey: string | null
	readonly tools: ReadonlyArray<FoldTool<unknown>>
	readonly hooks: HookConfig
	readonly systemPrompt: ReadonlyArray<string>
}

/** Everything one subagent launch/resume needs, resolved before the run fiber forks. */
type LaunchSubagentParams = {
	readonly subagentId: AgentId
	/** Registry type name recorded on agent_started; null for forks. */
	readonly agentTypeName: string | null
	/** Human-readable label for interrupt notes ("researcher", "fork of agent_x..."). */
	readonly agentLabel: string
	readonly parentAgentId: AgentId
	readonly toolCallId: ToolCallId
	readonly mode: AgentLaunchMode
	readonly fork: AgentFork | null
	readonly model: FoldModel<unknown>
	readonly promptCacheKey: string | null
	readonly tools: ReadonlyArray<RealizedFoldTool>
	readonly hooks: HookConfig
	/** Leading blocks for fresh starts (entry blocks + tool-contributed blocks); null for forks/resumes. */
	readonly systemPrompt: ReadonlyArray<string> | null
	/** The preloaded skill name recorded on agent_started (fresh starts only). */
	readonly skillParam: string | null
	readonly messages: Arr.NonEmptyReadonlyArray<string>
	/** Fresh dispatch/fork writes agent_started; resume re-enters, optionally after a model transition. */
	readonly launch:
		| { readonly _tag: 'start' }
		| {
				readonly _tag: 'resume'
				readonly modelTransition: { readonly systemPrompt: ReadonlyArray<string> | null } | null
		  }
	readonly interruptNote: InterruptNoteService
}

const SubagentLaunch = Data.taggedEnum<LaunchSubagentParams['launch']>()

/** Leading blocks for one agent: its own blocks, then its tools' contributed blocks. */
const leadingBlocksFor = (
	systemPrompt: ReadonlyArray<string>,
	realized: RealizedAgentTools,
): ReadonlyArray<string> | null => {
	const blocks = [...systemPrompt, ...realized.promptBlocks]
	return Arr.isArrayEmpty(blocks) ? null : blocks
}

/**
 * The note embedded in the dispatcher's synthetic result if this call is interrupted. Set with zero
 * turns the moment the subagent id exists, then kept current by the turn watcher as the subagent's
 * assistant messages land - so whenever the interruption strikes, the note already reflects the last
 * completed turn (no dependence on teardown ordering).
 */
const interruptedSubagentNote = (agentLabel: string, subagentId: AgentId, turnsThisRun: number): string =>
	`Subagent ${agentLabel} (agent_id: ${shortAgentId(subagentId)}) was interrupted after ${turnsThisRun} ` +
	`turn${turnsThisRun === 1 ? '' : 's'}, before completing. Its progress up to the interruption is saved. ` +
	`Pass agent_id: ${shortAgentId(subagentId)} to the subagent tool to resume it.`

const findAgentStarted = (entries: ReadonlyArray<LogEntry>, agentId: AgentId): AgentStartedLogEntry | null =>
	entries.find(
		(entry): entry is AgentStartedLogEntry =>
			Predicate.isTagged(entry, 'agent_started') && entry.agentId === agentId,
	) ?? null

/** Count assistant turns for one subagent: this dispatch/resume (by toolCallId) and lifetime total. */
const countAssistantTurns = (
	entries: ReadonlyArray<LogEntry>,
	agentId: AgentId,
	toolCallId: ToolCallId,
): { readonly thisRun: TurnCount; readonly total: TurnCount } => {
	const own = entries.filter(
		(entry): entry is AssistantMessageLogEntry =>
			Predicate.isTagged(entry, 'assistant-message') && entry.agentId === agentId,
	)

	return {
		thisRun: own.filter((entry) => entry.toolCallId === toolCallId).length,
		total: own.length,
	}
}

/** The subagent's final assistant text for this run, or null when it produced none. */
const lastAssistantTextForRun = (
	entries: ReadonlyArray<LogEntry>,
	agentId: AgentId,
	toolCallId: ToolCallId,
): string | null => {
	const lastAssistant = entries.findLast(
		(entry): entry is AssistantMessageLogEntry =>
			Predicate.isTagged(entry, 'assistant-message') &&
			entry.agentId === agentId &&
			entry.toolCallId === toolCallId,
	)
	if (lastAssistant === undefined) return null

	const text = encodedContentText(lastAssistant.message.content)
	return text.length > 0 ? text : null
}

/** Structural model-binding comparison deciding whether a resume needs a D17 transition. */
const activeModelsEquivalent = Schema.toEquivalence(Schema.NullOr(ActiveModel))
const activeModelsDiffer = (left: ActiveModel | null, right: ActiveModel | null): boolean =>
	!activeModelsEquivalent(left, right)

const CHILD_CACHE_SUFFIX_LENGTH = 28
const MAX_PROMPT_CACHE_KEY_LENGTH = 64

/** Derive a bounded, deterministic child cache-affinity key from its parent and durable id. */
export const deriveChildPromptCacheKey = (parentKey: string, agentId: AgentId): Effect.Effect<string> => {
	const suffix = `:${agentId.slice(-CHILD_CACHE_SUFFIX_LENGTH)}`
	const parentLength = MAX_PROMPT_CACHE_KEY_LENGTH - suffix.length
	return Effect.succeed(`${parentKey.slice(0, parentLength)}${suffix}`)
}

const appendToEventLog = (input: LogEntryInput): Effect.Effect<LogEntry, never, EventLog> =>
	EventLog.use((eventLog) => eventLog.append(input)).pipe(Effect.orDie)

const collectEntries: Effect.Effect<ReadonlyArray<LogEntry>, never, EventLog> = EventLog.use((eventLog) =>
	Stream.runCollect(eventLog.entries()),
).pipe(
	Effect.orDie,
	Effect.map((entries): ReadonlyArray<LogEntry> => entries),
)

/** Resolve one registry entry's model binding: a role name reads the current profiles map. */
const resolveModelBinding = (
	binding: SubagentModelBinding<unknown>,
): Effect.Effect<FoldModel<unknown>, never, Profiles> =>
	isProfileRole(binding) ? Profiles.use((profiles) => profiles.resolve(binding)) : Effect.succeed(binding)

/** Atomically claim a subagent id in the session registry; already-running means Busy. */
const claimRunningSubagent = (subagentId: AgentId): Effect.Effect<void, SubagentBusyError, SessionControls> =>
	SessionControls.use((controls) => controls.claimRunning(subagentId)).pipe(
		Effect.flatMap((claimed) =>
			claimed ? Effect.void : Effect.fail(new SubagentBusyError({ agentId: subagentId })),
		),
	)

/** Claim an agent id for the enclosing scope: the session's running registry releases it on close. */
const holdRunningSubagent = (subagentId: AgentId) =>
	Effect.acquireRelease(claimRunningSubagent(subagentId), () =>
		SessionControls.use((controls) => controls.releaseRunning(subagentId)),
	)

/**
 * Resolve which configuration an agent runs under: its registry entry (by agent_started.agentType),
 * the fork-source's configuration for forks, or the root's current configuration.
 */
const originatingConfigForAgent = (
	registry: AgentRegistry,
	entries: ReadonlyArray<LogEntry>,
	agentId: AgentId,
	seen: ReadonlySet<AgentId> = new Set(),
): OriginatingConfig | null => {
	if (seen.has(agentId)) return null
	const started = findAgentStarted(entries, agentId)
	if (started === null) return null

	if (started.agentType !== null) {
		const entry = registry.resolveAgentType(started.agentType)
		return entry === null ? null : OriginatingConfig.entry({ entry })
	}
	if (started.mode === 'fork' && started.fork !== null) {
		return originatingConfigForAgent(registry, entries, started.fork.fromAgentId, new Set([...seen, agentId]))
	}
	if (started.parentAgentId === null) return OriginatingConfig.root()

	return null
}

/**
 * The (model, tools, hooks, prompt) snapshot behind one originating configuration. Entry origins
 * resolve their model binding against the CURRENT profiles map, so fork/resume/continue of a
 * role-bound type all see the live binding (a fork clones the caller's binding by definition).
 */
const agentSnapshotForOrigin = (
	origin: OriginatingConfig,
): Effect.Effect<AgentConfigurationSnapshot, never, SessionAgents | Profiles> =>
	Match.valueTags(origin, {
		root: () => SessionAgents.use((agents) => agents.currentRoot),
		entry: ({ entry }) =>
			resolveModelBinding(entry.model).pipe(
				Effect.map((model) => ({
					model,
					promptCacheKey: null,
					tools: entry.tools,
					hooks: entry.hooks,
					systemPrompt: entry.systemPrompt,
				})),
			),
	})

/** Reconstruct one agent's effective configuration, including a persisted fork tool override. */
const agentSnapshotForAgent = Effect.fnUntraced(function* (entries: ReadonlyArray<LogEntry>, agentId: AgentId) {
	const { registry } = yield* SessionAgents
	const origin = originatingConfigForAgent(registry, entries, agentId)
	if (origin === null) return null

	const snapshot = yield* agentSnapshotForOrigin(origin)
	const started = findAgentStarted(entries, agentId)
	if (started === null) return snapshot
	const withCacheKey = { ...snapshot, promptCacheKey: started.promptCacheKey ?? snapshot.promptCacheKey }
	const definitionId = started.fork?.definitionId
	if (definitionId === undefined) return withCacheKey

	const definition = registry.resolveForkAgentDefinition(definitionId)
	if (definition === null) {
		return yield* Effect.die(
			new Error(`fork agent definition "${definitionId}" required by ${agentId} is not registered`),
		)
	}

	return { ...withCacheKey, tools: definition.tools }
})

/** Every ancestor of an agent (parent chain from agent_started rows), for the resume self-guard. */
const ancestorAgentIds = (entries: ReadonlyArray<LogEntry>, agentId: AgentId): ReadonlySet<AgentId> => {
	const ancestors = new Set<AgentId>()
	let current: AgentId | null = agentId

	while (current !== null && !ancestors.has(current)) {
		const started = findAgentStarted(entries, current)
		if (started === null) break
		current = started.parentAgentId
		if (current !== null) ancestors.add(current)
	}

	return ancestors
}

/** Load and render a preloaded skill through the dispatcher's own skillTool source (§2.3). */
const preloadedSkillMessage = Effect.fnUntraced(function* (
	dispatcherSnapshot: AgentConfigurationSnapshot,
	skillName: string,
) {
	const agents = yield* SessionAgents
	const realized = agents.realizeTools(dispatcherSnapshot.tools)

	if (realized.skillSource === null) {
		return yield* new SkillNotFoundError({ name: skillName, availableSkills: [] })
	}

	const skill = yield* realized.skillSource
		.load(skillName)
		.pipe(Effect.catchTag('SkillSourceError', (error) => Effect.die(error)))

	return renderSkillContent(skill)
})

/** The durable rows marking one interrupted run: the interruption notice, then the terminal marker. */
const writeInterruptedMarkers = Effect.fnUntraced(function* (envelope: {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId | null
}) {
	const ids = yield* Ids
	yield* appendToEventLog(
		LogEntryInputs['user-message']({
			...envelope,
			messageId: yield* ids.makeMessageId,
			message: encodeUserMessage(
				Prompt.userMessage({
					content: [
						Prompt.textPart({
							text: '<system-information>You were interrupted by the user before completing this work.</system-information>',
						}),
					],
				}),
			),
		}),
	)
	yield* appendToEventLog(
		LogEntryInputs['agent-finished']({
			...envelope,
			outcome: 'interrupted',
			resultText: null,
			reason: 'interrupted by the user',
		}),
	)
})

/** Uninterruptible exit finalizer: durable interrupt/error markers + the turn-counting note. */
const writeSubagentExitMarkers =
	(params: LaunchSubagentParams) =>
	(exit: Exit.Exit<AgentFinishedLogEntry, never>): Effect.Effect<void, never, EventLog | Ids> =>
		Effect.gen(function* () {
			if (Exit.isSuccess(exit)) return

			const entries = yield* collectEntries
			const finishedThisRun = entries.some(
				(entry) =>
					Predicate.isTagged(entry, 'agent-finished') &&
					entry.agentId === params.subagentId &&
					entry.toolCallId === params.toolCallId,
			)
			if (finishedThisRun) return

			const envelope = {
				agentId: params.subagentId,
				parentAgentId: params.parentAgentId,
				toolCallId: params.toolCallId,
			}
			if (Cause.hasInterrupts(exit.cause)) {
				yield* writeInterruptedMarkers(envelope)
			} else {
				yield* appendToEventLog(
					LogEntryInputs['agent-finished']({
						...envelope,
						outcome: 'error',
						resultText: null,
						reason: modelVisibleErrorDetailsFromCause(exit.cause),
					}),
				)
			}
		})

/** Fold a finished (or torn-down) subagent run into its result. Errors and interrupts are results. */
const subagentResultFromExit = (
	params: LaunchSubagentParams,
	exit: Exit.Exit<AgentFinishedLogEntry, never>,
	entries: ReadonlyArray<LogEntry>,
): SubagentResult => {
	const turns = countAssistantTurns(entries, params.subagentId, params.toolCallId)

	if (Exit.isSuccess(exit)) {
		const finished = exit.value
		return {
			agentId: params.subagentId,
			outcome: finished.outcome,
			resultText: finished.resultText,
			errorMessage: finished.outcome === 'error' ? finished.reason : null,
			turnsThisRun: turns.thisRun,
			turnsTotal: turns.total,
		}
	}

	const interrupted = Cause.hasInterrupts(exit.cause)
	return {
		agentId: params.subagentId,
		outcome: interrupted ? 'interrupted' : 'error',
		resultText: lastAssistantTextForRun(entries, params.subagentId, params.toolCallId),
		errorMessage: interrupted ? null : modelVisibleErrorDetailsFromCause(exit.cause),
		turnsThisRun: turns.thisRun,
		turnsTotal: turns.total,
	}
}

/**
 * Keep the interrupt note current as the subagent works: each completed turn (one assistant-message row
 * under this dispatch's tool call) bumps the count, so whenever an interruption strikes, the
 * dispatcher's synthetic result already carries an accurate "interrupted after N turns" note - no
 * dependence on teardown ordering.
 */
const watchSubagentTurns = Effect.fnUntraced(function* (params: LaunchSubagentParams) {
	const eventLog = yield* EventLog
	const turnsSeen = yield* Ref.make(0)

	yield* eventLog.subscribe().pipe(
		Stream.filter(
			(entry) =>
				Predicate.isTagged(entry, 'assistant-message') &&
				entry.agentId === params.subagentId &&
				entry.toolCallId === params.toolCallId,
		),
		Stream.tap(() =>
			Ref.updateAndGet(turnsSeen, (count) => count + 1).pipe(
				Effect.flatMap((turns) =>
					params.interruptNote.set(interruptedSubagentNote(params.agentLabel, params.subagentId, turns)),
				),
			),
		),
		Stream.runDrain,
		Effect.orDie,
	)
})

/**
 * Run one subagent launch/resume to its result: claim the id, provision this agent's runtime into the
 * dispatch scope, write the start (or resume transition), fork the run fiber, await its Exit, and fold.
 * The dispatch scope closing (dispatcher interrupted) interrupts the run fiber; the onExit finalizer
 * then writes the durable markers before the interruption propagates.
 */
const runSubagentToResult = (params: LaunchSubagentParams) =>
	Effect.scoped(
		Effect.gen(function* () {
			const controls = yield* SessionControls
			yield* holdRunningSubagent(params.subagentId)

			const agentRuntimeForSubagent = yield* provisionAgentRuntime({
				model: params.model,
				tools: params.tools,
				hooks: params.hooks,
			})

			if (SubagentLaunch.$is('start')(params.launch)) {
				yield* agentRuntimeForSubagent.start({
					agentId: params.subagentId,
					parentAgentId: params.parentAgentId,
					toolCallId: params.toolCallId,
					mode: params.mode,
					fork: params.fork,
					skill: params.skillParam,
					agentType: params.agentTypeName,
					model: params.model.activeModel,
					promptCacheKey: params.promptCacheKey,
					systemPrompt: params.systemPrompt,
				})
			} else if (params.launch.modelTransition !== null) {
				yield* agentRuntimeForSubagent.switchModel({
					agentId: params.subagentId,
					parentAgentId: params.parentAgentId,
					toolCallId: params.toolCallId,
					model: params.model.activeModel,
					systemPrompt: params.launch.modelTransition.systemPrompt,
					reason: 'resume: the configured model for this agent changed since it last ran',
				})
			}

			const subagentRunFiber = yield* Effect.forkScoped(
				agentRuntimeForSubagent
					.run({
						agentId: params.subagentId,
						parentAgentId: params.parentAgentId,
						toolCallId: params.toolCallId,
						messages: params.messages,
					})
					.pipe(Effect.onExit(writeSubagentExitMarkers(params))),
			)
			// Closing the dispatch scope interrupts the subagent and awaits its exit finalizers, so the
			// durable interrupt/error markers land before the dispatch call returns.
			yield* Effect.addFinalizer(() => Fiber.interrupt(subagentRunFiber))
			yield* Effect.forkScoped(watchSubagentTurns(params))
			yield* controls.setRunningFiber(params.subagentId, subagentRunFiber)

			const exit = yield* Fiber.await(subagentRunFiber)
			const entries = yield* collectEntries

			return subagentResultFromExit(params, exit, entries)
		}),
	)

/** A fresh id can never be running; a Busy claim failure on one is an engine bug. */
const dieOnBusy = (error: SubagentBusyError): Effect.Effect<never> =>
	Effect.die(new Error(`freshly minted subagent id ${error.agentId} was already running`))

/**
 * Uninterruptible exit markers for a direct SDK continuation (D8): same honesty as dispatch markers,
 * but with the null envelope (no dispatching tool call) and a seq baseline guard - a continuation reuses
 * the null toolCallId across runs, so "did this run already write its terminal marker" is answered by
 * seq position, not by call identity.
 */
const writeDirectExitMarkers =
	(agentId: AgentId, baselineSeq: LogSeq) =>
	(exit: Exit.Exit<AgentFinishedLogEntry>): Effect.Effect<void, never, EventLog | Ids> =>
		Effect.gen(function* () {
			if (Exit.isSuccess(exit)) return

			const entries = yield* collectEntries
			const finishedThisRun = entries.some(
				(entry) =>
					Predicate.isTagged(entry, 'agent-finished') && entry.agentId === agentId && entry.seq > baselineSeq,
			)
			if (finishedThisRun) return

			const envelope = { agentId, parentAgentId: null, toolCallId: null }
			if (Cause.hasInterrupts(exit.cause)) {
				yield* writeInterruptedMarkers(envelope)
			} else {
				yield* appendToEventLog(
					LogEntryInputs['agent-finished']({
						...envelope,
						outcome: 'error',
						resultText: null,
						reason: modelVisibleErrorDetailsFromCause(exit.cause),
					}),
				)
			}
		})

/**
 * Continue a finished subagent from the SDK, with no dispatching tool call (D8): the prompt appends as a
 * user message with a null toolCallId/parentAgentId envelope, the agent's loop restarts under its own
 * configuration (running the D17 model transition first when its binding changed), and the caller gets
 * the durable terminal entry - interrupts and defects included, via their durable markers. This is the
 * session handle's `send(text, { agentId })`.
 */
export const continueSubagent = Effect.fn('fold.subagents.continue')(function* (input: ContinueSubagentInput) {
	const agents = yield* SessionAgents
	const controls = yield* SessionControls
	const entries = yield* collectEntries
	const started = findAgentStarted(entries, input.agentId)
	if (started === null) {
		return yield* new SubagentNotFoundError({ requested: input.agentId })
	}

	const snapshot = yield* agentSnapshotForAgent(entries, input.agentId)
	if (snapshot === null) {
		return yield* Effect.die(new Error(`continuation target ${input.agentId} has no resolvable configuration`))
	}
	const realized = agents.realizeTools(snapshot.tools)

	const projected = runtimeForAgent(entries, input.agentId)
	const modelTransition = activeModelsDiffer(snapshot.model.activeModel, projected.activeModel)
		? { systemPrompt: leadingBlocksFor(snapshot.systemPrompt, realized) }
		: null

	const lastEntry = entries.at(-1)
	if (lastEntry === undefined) {
		return yield* Effect.die(new Error('continuation requested on an empty session log'))
	}
	const baselineSeq = lastEntry.seq

	return yield* Effect.scoped(
		Effect.gen(function* () {
			yield* holdRunningSubagent(input.agentId)

			const agentRuntimeForSubagent = yield* provisionAgentRuntime({
				model: snapshot.model,
				tools: realized.tools,
				hooks: snapshot.hooks,
			})

			if (modelTransition !== null) {
				yield* agentRuntimeForSubagent.switchModel({
					agentId: input.agentId,
					parentAgentId: null,
					toolCallId: null,
					model: snapshot.model.activeModel,
					systemPrompt: modelTransition.systemPrompt,
					reason: 'continue: the configured model for this agent changed since it last ran',
				})
			}

			const runFiber = yield* Effect.forkScoped(
				agentRuntimeForSubagent
					.run({
						agentId: input.agentId,
						parentAgentId: null,
						toolCallId: null,
						messages: [input.prompt],
					})
					.pipe(Effect.onExit(writeDirectExitMarkers(input.agentId, baselineSeq))),
			)
			yield* Effect.addFinalizer(() => Fiber.interrupt(runFiber))
			yield* controls.setRunningFiber(input.agentId, runFiber)

			const exit = yield* Fiber.await(runFiber)
			if (Exit.isSuccess(exit)) return exit.value

			// Interrupted or dead: the exit markers above wrote the terminal entry - return it.
			const after = yield* collectEntries
			const finished = after.findLast(
				(entry): entry is AgentFinishedLogEntry =>
					Predicate.isTagged(entry, 'agent-finished') && entry.agentId === input.agentId,
			)
			if (finished === undefined) {
				return yield* Effect.die(new Error(`continuation of ${input.agentId} ended without a terminal marker`))
			}
			return finished
		}),
	)
})

/** Dispatch one fresh subagent of a registered type from inside the executing subagent tool call. */
export const dispatchSubagent = Effect.fn('fold.subagents.dispatch')(function* (input: DispatchSubagentInput) {
	if (!input.allowedAgents.includes(input.agent)) {
		return yield* new SubagentTypeNotInRosterError({
			requested: input.agent,
			availableAgents: input.allowedAgents,
		})
	}

	const agents = yield* SessionAgents
	const entry = agents.registry.resolveAgentType(input.agent)
	if (entry === null) {
		return yield* Effect.die(
			new Error(`agent type "${input.agent}" is in a roster but missing from the session registry`),
		)
	}

	const ids = yield* Ids
	const dispatcher = yield* CurrentAgent
	const currentCall = yield* CurrentToolCall
	const interruptNote = yield* InterruptNote

	// Preload resolves through the DISPATCHER's skill source, and fails before any durable subagent row
	// exists (§2.3 step 6).
	const entries = yield* collectEntries
	const dispatcherSnapshot = yield* agentSnapshotForAgent(entries, dispatcher.agentId)
	if (dispatcherSnapshot === null) {
		return yield* Effect.die(new Error(`dispatching agent ${dispatcher.agentId} has no resolvable configuration`))
	}
	const preloaded = input.skill === null ? null : yield* preloadedSkillMessage(dispatcherSnapshot, input.skill)

	const subagentId = yield* ids.makeAgentId
	const promptCacheKey =
		dispatcherSnapshot.promptCacheKey === null
			? null
			: yield* deriveChildPromptCacheKey(dispatcherSnapshot.promptCacheKey, subagentId)
	yield* interruptNote.set(interruptedSubagentNote(entry.name, subagentId, 0))

	const realized = agents.realizeTools(entry.tools)

	return yield* runSubagentToResult({
		subagentId,
		agentTypeName: entry.name,
		agentLabel: entry.name,
		parentAgentId: dispatcher.agentId,
		toolCallId: currentCall.toolCallId,
		mode: 'fresh',
		fork: null,
		// Role bindings resolve at dispatch time: a setProfile swap binds the NEXT dispatch.
		model: yield* resolveModelBinding(entry.model),
		promptCacheKey,
		tools: realized.tools,
		hooks: entry.hooks,
		systemPrompt: leadingBlocksFor(entry.systemPrompt, realized),
		skillParam: input.skill,
		messages: preloaded === null ? [input.prompt] : [input.prompt, preloaded],
		launch: SubagentLaunch.start(),
		interruptNote,
	}).pipe(Effect.catchTag('SubagentBusyError', dieOnBusy))
})

/** Fork the executing agent: a new subagent over a copy of the caller's context. */
export const forkSubagent = Effect.fn('fold.subagents.fork')(function* (input: ForkSubagentInput) {
	const agents = yield* SessionAgents
	const ids = yield* Ids
	const dispatcher = yield* CurrentAgent
	const currentCall = yield* CurrentToolCall
	const interruptNote = yield* InterruptNote

	const entries = yield* collectEntries
	const dispatcherSnapshot = yield* agentSnapshotForAgent(entries, dispatcher.agentId)
	if (dispatcherSnapshot === null) {
		return yield* Effect.die(new Error(`fork dispatcher ${dispatcher.agentId} has no resolvable configuration`))
	}

	const preloaded = input.skill === null ? null : yield* preloadedSkillMessage(dispatcherSnapshot, input.skill)

	const forkDefinition =
		input.forkAgentDefinitionId === null
			? null
			: agents.registry.resolveForkAgentDefinition(input.forkAgentDefinitionId)
	if (input.forkAgentDefinitionId !== null && forkDefinition === null) {
		return yield* Effect.die(new Error(`fork agent definition "${input.forkAgentDefinitionId}" is not registered`))
	}
	const forkTools = forkDefinition?.tools ?? dispatcherSnapshot.tools
	const realized = agents.realizeTools(forkTools)

	// The fork sees the caller's history up to the head observed here; rows appended by parallel work
	// after this observation are deliberately outside the fork's view.
	const lastEntry = entries.at(-1)
	if (lastEntry === undefined) {
		return yield* Effect.die(new Error('fork requested on an empty session log'))
	}

	const subagentId = yield* ids.makeAgentId
	const promptCacheKey =
		dispatcherSnapshot.promptCacheKey === null
			? null
			: yield* deriveChildPromptCacheKey(dispatcherSnapshot.promptCacheKey, subagentId)
	const agentLabel = `fork of ${shortAgentId(dispatcher.agentId)}`
	yield* interruptNote.set(interruptedSubagentNote(agentLabel, subagentId, 0))
	const fork: Mutable<AgentFork> = { fromAgentId: dispatcher.agentId, atSeq: lastEntry.seq }
	if (input.forkAgentDefinitionId !== null) {
		fork.definitionId = input.forkAgentDefinitionId
	}
	if (input.history !== undefined) {
		fork.history = input.history
	}

	return yield* runSubagentToResult({
		subagentId,
		agentTypeName: null,
		agentLabel,
		parentAgentId: dispatcher.agentId,
		toolCallId: currentCall.toolCallId,
		mode: 'fork',
		fork,
		model: dispatcherSnapshot.model,
		promptCacheKey,
		tools: realized.tools,
		hooks: dispatcherSnapshot.hooks,
		// Forks append no leading system message: the fold carries the caller's blocks (D21).
		systemPrompt: null,
		skillParam: input.skill,
		messages: preloaded === null ? [input.prompt] : [input.prompt, preloaded],
		launch: SubagentLaunch.start(),
		interruptNote,
	}).pipe(Effect.catchTag('SubagentBusyError', dieOnBusy))
})

/** Resume a previously launched subagent by reference, from inside the executing subagent tool call. */
export const resumeSubagent = Effect.fn('fold.subagents.resume')(function* (input: ResumeSubagentInput) {
	const agents = yield* SessionAgents
	const dispatcher = yield* CurrentAgent
	const currentCall = yield* CurrentToolCall
	const interruptNote = yield* InterruptNote

	const entries = yield* collectEntries
	// The wire carries a reference (full id or unique short prefix); resolve it against every started
	// agent before anything else. Ambiguity is a not-found carrying the candidates.
	const resolution = resolveAgentIdRef(agentIdsFromEntries(entries), input.agentId)
	const agentId = yield* Match.valueTags(resolution, {
		resolved: ({ agentId }) => Effect.succeed(agentId),
		'not-found': () => Effect.fail(new SubagentNotFoundError({ requested: input.agentId })),
		ambiguous: ({ candidates }) => Effect.fail(new SubagentNotFoundError({ requested: input.agentId, candidates })),
	})

	const started = findAgentStarted(entries, agentId)
	if (started === null) {
		return yield* new SubagentNotFoundError({ requested: input.agentId })
	}

	// Resuming yourself or a running ancestor would run one agent's loop inside itself.
	if (agentId === dispatcher.agentId || ancestorAgentIds(entries, dispatcher.agentId).has(agentId)) {
		return yield* new SubagentBusyError({ agentId })
	}

	const dispatcherSnapshot = yield* agentSnapshotForAgent(entries, dispatcher.agentId)
	const preloaded =
		input.skill === null
			? null
			: dispatcherSnapshot === null
				? yield* new SkillNotFoundError({ name: input.skill, availableSkills: [] })
				: yield* preloadedSkillMessage(dispatcherSnapshot, input.skill)

	// The resumed agent's binding: its registry entry when its type is (still) registered, otherwise its
	// fork-source chain, otherwise the dispatcher's own configuration.
	const snapshot = (yield* agentSnapshotForAgent(entries, agentId)) ?? dispatcherSnapshot
	if (snapshot === null) {
		return yield* Effect.die(new Error(`resume target ${agentId} has no resolvable configuration`))
	}
	const realized = agents.realizeTools(snapshot.tools)

	const projected = runtimeForAgent(entries, agentId)
	const modelTransition = activeModelsDiffer(snapshot.model.activeModel, projected.activeModel)
		? { systemPrompt: leadingBlocksFor(snapshot.systemPrompt, realized) }
		: null

	const agentLabel = started.agentType ?? `subagent ${shortAgentId(agentId)}`
	yield* interruptNote.set(interruptedSubagentNote(agentLabel, agentId, 0))

	return yield* runSubagentToResult({
		subagentId: agentId,
		agentTypeName: started.agentType,
		agentLabel,
		parentAgentId: dispatcher.agentId,
		toolCallId: currentCall.toolCallId,
		mode: started.mode,
		fork: started.fork,
		model: snapshot.model,
		promptCacheKey: snapshot.promptCacheKey,
		tools: realized.tools,
		hooks: snapshot.hooks,
		systemPrompt: null,
		skillParam: input.skill,
		messages: preloaded === null ? [input.prompt] : [input.prompt, preloaded],
		launch: SubagentLaunch.resume({ modelTransition }),
		interruptNote,
	})
})
