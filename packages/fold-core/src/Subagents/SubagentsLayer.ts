/**
 * This file implements the Subagents engine (D21) - the deep module behind the subagent tool. It owns
 * the whole choreography: roster guards, id minting, per-dispatch runtime provisioning (own model,
 * tools, hooks over the shared session services), the durable agent_started/user-message writes via
 * AgentRuntime, the subagent run fiber (forked into the dispatch call's scope so interrupting the
 * dispatcher structurally tears the subagent down), exit folding (a subagent that errors, dies, or is
 * interrupted is a RESULT, never a failure - capture-then-narrow like the tool-settlement seam), the
 * uninterruptible exit finalizers that keep the log honest (interrupt/error markers + the
 * InterruptNote naming the subagent id and turn count), skill preload through the dispatcher's own
 * skillTool source, and resume - including the D17 model transition when the configured binding
 * changed since the subagent last ran. Registry entries may bind their model by profile role name
 * (profiles slice): the engine resolves role bindings through the session's Profiles map at every
 * consumption point - dispatch, and the origin snapshot feeding fork/resume/continue - so a
 * `setProfile` swap binds on the very next run and the existing transition diff sees only concrete
 * models.
 */
import { Cause, Effect, Exit, Fiber, Ref, Schema, Stream } from 'effect'
import type { Array as Arr } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import type { FoldModel } from '../Api/ModelDescriptor'
import { AgentProvisioner } from '../Api/Provisioning'
import type { RealizedFoldTool, FoldTool } from '../Api/ToolDefinition'
import { EventLog } from '../EventLog/EventLogService'
import type {
	AgentFinishedLogEntry,
	AgentFork,
	AgentLaunchMode,
	AgentStartedLogEntry,
	AssistantMessageLogEntry,
	LogEntry,
	LogEntryInput,
	LogSeq,
} from '../EventLog/Schemas'
import type { HookConfig } from '../HookRunner/Types'
import { Ids, type AgentId, type ToolCallId } from '../Ids'
import { runtimeForAgent } from '../Projection/Projection'
import { Profiles } from '../Session/Profiles'
import { SessionControls } from '../Session/SessionControls'
import { SkillNotFoundError, type SkillSourceService } from '../Skills/SkillSource'
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
import type { SubagentResult, TurnCount } from './Schemas'
import type { SubagentModelBinding } from './SubagentDefinition'
import type {
	ContinueSubagentInput,
	DispatchSubagentInput,
	ForkSubagentInput,
	ResumeSubagentInput,
	SubagentsService,
} from './SubagentsService'

const encodeUserMessage = Schema.encodeUnknownSync(Prompt.UserMessage)

/** One agent's tools realized against the session-start contributions (once-per-value inits). */
export type RealizedAgentTools = {
	readonly tools: ReadonlyArray<RealizedFoldTool>
	/** Prompt blocks contributed by session-initialized tools, in tools-array order. */
	readonly promptBlocks: ReadonlyArray<string>
	/** The skill source contributed by this agent's skillTool, for dispatch-time skill preload. */
	readonly skillSource: SkillSourceService | null
}

/** The root agent's current configuration; model switches move it (read fresh per dispatch). */
export type RootAgentSnapshot = {
	readonly model: FoldModel
	/** The root's tools as configured (system-tool values included). */
	readonly tools: ReadonlyArray<FoldTool>
	readonly hooks: HookConfig
	/** The root's own leading blocks, WITHOUT tool-contributed blocks (those come from realization). */
	readonly systemPrompt: string | ReadonlyArray<string> | null
}

/** Composition-root wiring for the Subagents engine, supplied by `startSession`. */
export type SubagentsConfig = {
	readonly registry: AgentRegistry
	/** Realize one agent's configured tools via the session-start contribution map (§2.5). */
	readonly realizeAgentTools: (tools: ReadonlyArray<FoldTool>) => RealizedAgentTools
	readonly currentRootAgent: Effect.Effect<RootAgentSnapshot>
}

/** Where an agent's configuration comes from: a registered type, or the root agent. */
type OriginatingConfig = { readonly _tag: 'entry'; readonly entry: RegisteredAgentType } | { readonly _tag: 'root' }

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
	readonly model: FoldModel
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

/** Fold a leading-prompt config value into an ordered block list. */
const promptBlocksOf = (systemPrompt: string | ReadonlyArray<string> | null): ReadonlyArray<string> =>
	systemPrompt === null ? [] : typeof systemPrompt === 'string' ? [systemPrompt] : systemPrompt

/** Leading blocks for one agent: its own blocks, then its tools' contributed blocks. */
const leadingBlocksFor = (
	systemPrompt: string | ReadonlyArray<string> | null,
	realized: RealizedAgentTools,
): ReadonlyArray<string> | null => {
	const blocks = [...promptBlocksOf(systemPrompt), ...realized.promptBlocks]
	return blocks.length === 0 ? null : blocks
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
		(entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started' && entry.agentId === agentId,
	) ?? null

/** Count assistant turns for one subagent: this dispatch/resume (by toolCallId) and lifetime total. */
const countAssistantTurns = (
	entries: ReadonlyArray<LogEntry>,
	agentId: AgentId,
	toolCallId: ToolCallId,
): { readonly thisRun: TurnCount; readonly total: TurnCount } => {
	const own = entries.filter(
		(entry): entry is AssistantMessageLogEntry => entry._tag === 'assistant-message' && entry.agentId === agentId,
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
			entry._tag === 'assistant-message' && entry.agentId === agentId && entry.toolCallId === toolCallId,
	)
	if (lastAssistant === undefined) return null

	const content = lastAssistant.message.content
	if (typeof content === 'string') return content.length > 0 ? content : null

	const text = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
	return text.length > 0 ? text : null
}

/** Structural model-binding comparison deciding whether a resume needs a D17 transition. */
const activeModelsDiffer = (left: unknown, right: unknown): boolean => JSON.stringify(left) !== JSON.stringify(right)

/**
 * Build the Subagents engine over the session's shared services. `startSession` constructs this once
 * per session (after the registry and tool contributions exist) and publishes it as the ambient
 * per-call `Subagents` service every tool handler can reach.
 */
export const makeSubagents = (
	config: SubagentsConfig,
): Effect.Effect<SubagentsService, never, EventLog | Ids | AgentProvisioner | SessionControls | Profiles> =>
	Effect.gen(function* () {
		const eventLog = yield* EventLog
		const ids = yield* Ids
		const provisioner = yield* AgentProvisioner
		// The session-wide running registry (slice 2): claiming here is what makes a dispatched subagent
		// visible to external steer/targeted-interrupt, and what the Busy guard reads.
		const controls = yield* SessionControls
		// The session-wide role->model bindings (profiles slice): role-bound registry entries resolve
		// here at each dispatch/resume, so a setProfile swap binds on the very next run.
		const profiles = yield* Profiles

		/** Resolve one registry entry's model binding: a role name reads the current profiles map. */
		const resolveModelBinding = (binding: SubagentModelBinding): Effect.Effect<FoldModel> =>
			typeof binding === 'string' ? profiles.resolve(binding) : Effect.succeed(binding)

		const appendToEventLog = (input: LogEntryInput): Effect.Effect<LogEntry> =>
			eventLog.append(input).pipe(Effect.orDie)

		const collectEntries: Effect.Effect<ReadonlyArray<LogEntry>> = Stream.runCollect(eventLog.entries()).pipe(
			Effect.orDie,
			Effect.map((entries): ReadonlyArray<LogEntry> => entries),
		)

		/** Atomically claim a subagent id in the session registry; already-running means Busy. */
		const claimRunningSubagent = (subagentId: AgentId): Effect.Effect<void, SubagentBusyError> =>
			controls
				.claimRunning(subagentId)
				.pipe(
					Effect.flatMap((claimed) =>
						claimed ? Effect.void : Effect.fail(new SubagentBusyError({ agentId: subagentId })),
					),
				)

		/**
		 * Resolve which configuration an agent runs under: its registry entry (by agent_started.agentType),
		 * the fork-source's configuration for forks, or the root's current configuration.
		 */
		const originatingConfigForAgent = (
			entries: ReadonlyArray<LogEntry>,
			agentId: AgentId,
			seen: ReadonlySet<AgentId> = new Set(),
		): OriginatingConfig | null => {
			if (seen.has(agentId)) return null
			const started = findAgentStarted(entries, agentId)
			if (started === null) return null

			if (started.agentType !== null) {
				const entry = config.registry.resolveAgentType(started.agentType)
				return entry === null ? null : { _tag: 'entry', entry }
			}
			if (started.mode === 'fork' && started.fork !== null) {
				return originatingConfigForAgent(entries, started.fork.fromAgentId, new Set([...seen, agentId]))
			}
			if (started.parentAgentId === null) return { _tag: 'root' }

			return null
		}

		/**
		 * The (model, tools, hooks, prompt) snapshot behind one originating configuration. Entry origins
		 * resolve their model binding against the CURRENT profiles map, so fork/resume/continue of a
		 * role-bound type all see the live binding (a fork clones the caller's binding by definition).
		 */
		const agentSnapshotForOrigin = (
			origin: OriginatingConfig,
		): Effect.Effect<{
			readonly model: FoldModel
			readonly tools: ReadonlyArray<FoldTool>
			readonly hooks: HookConfig
			readonly systemPrompt: string | ReadonlyArray<string> | null
		}> =>
			origin._tag === 'root'
				? config.currentRootAgent
				: resolveModelBinding(origin.entry.model).pipe(
						Effect.map((model) => ({
							model,
							tools: origin.entry.tools,
							hooks: origin.entry.hooks,
							systemPrompt: origin.entry.systemPrompt,
						})),
					)

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
		const preloadedSkillMessage = (
			dispatcherOrigin: OriginatingConfig,
			skillName: string,
		): Effect.Effect<string, SkillNotFoundError> =>
			Effect.gen(function* () {
				const snapshot = yield* agentSnapshotForOrigin(dispatcherOrigin)
				const realized = config.realizeAgentTools(snapshot.tools)

				if (realized.skillSource === null) {
					return yield* new SkillNotFoundError({ name: skillName, availableSkills: [] })
				}

				const skill = yield* realized.skillSource
					.load(skillName)
					.pipe(Effect.catchTag('SkillSourceError', (error) => Effect.die(error)))

				return renderSkillContent(skill)
			})

		/** Uninterruptible exit finalizer: durable interrupt/error markers + the turn-counting note. */
		const writeSubagentExitMarkers =
			(params: LaunchSubagentParams) =>
			(exit: Exit.Exit<AgentFinishedLogEntry, never>): Effect.Effect<void> =>
				Effect.gen(function* () {
					if (Exit.isSuccess(exit)) return

					const cause = exit.cause
					const entries = yield* collectEntries
					const finishedThisRun = entries.some(
						(entry) =>
							entry._tag === 'agent-finished' &&
							entry.agentId === params.subagentId &&
							entry.toolCallId === params.toolCallId,
					)

					if (!finishedThisRun) {
						if (Cause.hasInterrupts(cause)) {
							yield* appendToEventLog({
								_tag: 'user-message',
								agentId: params.subagentId,
								parentAgentId: params.parentAgentId,
								toolCallId: params.toolCallId,
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
							})
							yield* appendToEventLog({
								_tag: 'agent-finished',
								agentId: params.subagentId,
								parentAgentId: params.parentAgentId,
								toolCallId: params.toolCallId,
								outcome: 'interrupted',
								resultText: null,
								reason: 'interrupted by the user',
							})
						} else {
							yield* appendToEventLog({
								_tag: 'agent-finished',
								agentId: params.subagentId,
								parentAgentId: params.parentAgentId,
								toolCallId: params.toolCallId,
								outcome: 'error',
								resultText: null,
								reason: modelVisibleErrorDetailsFromCause(cause),
							})
						}
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
		 * Run one subagent launch/resume to its result: claim the id, provision this agent's runtime into
		 * the dispatch scope, write the start (or resume transition), fork the run fiber, await its Exit,
		 * and fold. The dispatch scope closing (dispatcher interrupted) interrupts the run fiber; the
		 * onExit finalizer then writes the durable markers before the interruption propagates.
		 */
		const runSubagentToResult = (params: LaunchSubagentParams): Effect.Effect<SubagentResult, SubagentBusyError> =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* Effect.acquireRelease(claimRunningSubagent(params.subagentId), () =>
						controls.releaseRunning(params.subagentId),
					)

					const agentRuntimeForSubagent = yield* provisioner.provisionAgentRuntime({
						model: params.model,
						tools: params.tools,
						hooks: params.hooks,
					})

					if (params.launch._tag === 'start') {
						yield* agentRuntimeForSubagent.start({
							agentId: params.subagentId,
							parentAgentId: params.parentAgentId,
							toolCallId: params.toolCallId,
							mode: params.mode,
							fork: params.fork,
							skill: params.skillParam,
							agentType: params.agentTypeName,
							model: params.model.activeModel,
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
					// Closing the dispatch scope interrupts the subagent and awaits its exit finalizers,
					// so the durable interrupt/error markers land before the dispatch call returns.
					yield* Effect.addFinalizer(() => Fiber.interrupt(subagentRunFiber))

					// Keep the interrupt note current as the subagent works: each completed turn (one
					// assistant-message row under this dispatch's tool call) bumps the count, so whenever
					// an interruption strikes, the dispatcher's synthetic result already carries an
					// accurate "interrupted after N turns" note - no dependence on teardown ordering.
					const watchSubagentTurns = Effect.gen(function* () {
						const turnsSeen = yield* Ref.make(0)

						yield* eventLog.subscribe().pipe(
							Stream.filter(
								(entry) =>
									entry._tag === 'assistant-message' &&
									entry.agentId === params.subagentId &&
									entry.toolCallId === params.toolCallId,
							),
							Stream.tap(() =>
								Ref.updateAndGet(turnsSeen, (count) => count + 1).pipe(
									Effect.flatMap((turns) =>
										params.interruptNote.set(
											interruptedSubagentNote(params.agentLabel, params.subagentId, turns),
										),
									),
								),
							),
							Stream.runDrain,
							Effect.orDie,
						)
					})
					yield* Effect.forkScoped(watchSubagentTurns)
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
		 * Uninterruptible exit markers for a direct SDK continuation (D8): same honesty as dispatch
		 * markers, but with the null envelope (no dispatching tool call) and a seq baseline guard - a
		 * continuation reuses the null toolCallId across runs, so "did this run already write its
		 * terminal marker" is answered by seq position, not by call identity.
		 */
		const writeDirectExitMarkers =
			(agentId: AgentId, baselineSeq: LogSeq) =>
			(exit: Exit.Exit<AgentFinishedLogEntry>): Effect.Effect<void> =>
				Effect.gen(function* () {
					if (Exit.isSuccess(exit)) return

					const entries = yield* collectEntries
					const finishedThisRun = entries.some(
						(entry) =>
							entry._tag === 'agent-finished' && entry.agentId === agentId && entry.seq > baselineSeq,
					)
					if (finishedThisRun) return

					if (Cause.hasInterrupts(exit.cause)) {
						yield* appendToEventLog({
							_tag: 'user-message',
							agentId,
							parentAgentId: null,
							toolCallId: null,
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
						})
						yield* appendToEventLog({
							_tag: 'agent-finished',
							agentId,
							parentAgentId: null,
							toolCallId: null,
							outcome: 'interrupted',
							resultText: null,
							reason: 'interrupted by the user',
						})
					} else {
						yield* appendToEventLog({
							_tag: 'agent-finished',
							agentId,
							parentAgentId: null,
							toolCallId: null,
							outcome: 'error',
							resultText: null,
							reason: modelVisibleErrorDetailsFromCause(exit.cause),
						})
					}
				})

		const continueSubagent: SubagentsService['continueSubagent'] = Effect.fn('fold.subagents.continue')(
			(input: ContinueSubagentInput) =>
				Effect.gen(function* () {
					const entries = yield* collectEntries
					const started = findAgentStarted(entries, input.agentId)
					if (started === null) {
						return yield* new SubagentNotFoundError({ requested: input.agentId })
					}

					const targetOrigin = originatingConfigForAgent(entries, input.agentId)
					if (targetOrigin === null) {
						return yield* Effect.die(
							new Error(`continuation target ${input.agentId} has no resolvable configuration`),
						)
					}

					const snapshot = yield* agentSnapshotForOrigin(targetOrigin)
					const realized = config.realizeAgentTools(snapshot.tools)

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
							yield* Effect.acquireRelease(claimRunningSubagent(input.agentId), () =>
								controls.releaseRunning(input.agentId),
							)

							const agentRuntimeForSubagent = yield* provisioner.provisionAgentRuntime({
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
									entry._tag === 'agent-finished' && entry.agentId === input.agentId,
							)
							if (finished === undefined) {
								return yield* Effect.die(
									new Error(`continuation of ${input.agentId} ended without a terminal marker`),
								)
							}
							return finished
						}),
					)
				}),
		)

		const dispatch: SubagentsService['dispatch'] = Effect.fn('fold.subagents.dispatch')(
			(input: DispatchSubagentInput) =>
				Effect.gen(function* () {
					if (!input.allowedAgents.includes(input.agent)) {
						return yield* new SubagentTypeNotInRosterError({
							requested: input.agent,
							availableAgents: input.allowedAgents,
						})
					}

					const entry = config.registry.resolveAgentType(input.agent)
					if (entry === null) {
						return yield* Effect.die(
							new Error(
								`agent type "${input.agent}" is in a roster but missing from the session registry`,
							),
						)
					}

					const dispatcher = yield* CurrentAgent
					const currentCall = yield* CurrentToolCall
					const interruptNote = yield* InterruptNote

					// Preload resolves through the DISPATCHER's skill source, and fails before any durable
					// subagent row exists (§2.3 step 6).
					const entries = yield* collectEntries
					const dispatcherOrigin = originatingConfigForAgent(entries, dispatcher.agentId)
					const preloaded =
						input.skill === null
							? null
							: dispatcherOrigin === null
								? yield* new SkillNotFoundError({ name: input.skill, availableSkills: [] })
								: yield* preloadedSkillMessage(dispatcherOrigin, input.skill)

					const subagentId = yield* ids.makeAgentId
					yield* interruptNote.set(interruptedSubagentNote(entry.name, subagentId, 0))

					const realized = config.realizeAgentTools(entry.tools)

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
						tools: realized.tools,
						hooks: entry.hooks,
						systemPrompt: leadingBlocksFor(entry.systemPrompt, realized),
						skillParam: input.skill,
						messages: preloaded === null ? [input.prompt] : [input.prompt, preloaded],
						launch: { _tag: 'start' },
						interruptNote,
					}).pipe(Effect.catchTag('SubagentBusyError', dieOnBusy))
				}),
		)

		const fork: SubagentsService['fork'] = Effect.fn('fold.subagents.fork')((input: ForkSubagentInput) =>
			Effect.gen(function* () {
				const dispatcher = yield* CurrentAgent
				const currentCall = yield* CurrentToolCall
				const interruptNote = yield* InterruptNote

				const entries = yield* collectEntries
				const dispatcherOrigin = originatingConfigForAgent(entries, dispatcher.agentId)
				if (dispatcherOrigin === null) {
					return yield* Effect.die(
						new Error(`fork dispatcher ${dispatcher.agentId} has no resolvable configuration`),
					)
				}

				const preloaded =
					input.skill === null ? null : yield* preloadedSkillMessage(dispatcherOrigin, input.skill)

				const snapshot = yield* agentSnapshotForOrigin(dispatcherOrigin)
				const realized = config.realizeAgentTools(snapshot.tools)

				// The fork sees the caller's history up to the head observed here; rows appended by parallel
				// work after this observation are deliberately outside the fork's view.
				const lastEntry = entries.at(-1)
				if (lastEntry === undefined) {
					return yield* Effect.die(new Error('fork requested on an empty session log'))
				}

				const subagentId = yield* ids.makeAgentId
				const agentLabel = `fork of ${shortAgentId(dispatcher.agentId)}`
				yield* interruptNote.set(interruptedSubagentNote(agentLabel, subagentId, 0))

				return yield* runSubagentToResult({
					subagentId,
					agentTypeName: null,
					agentLabel,
					parentAgentId: dispatcher.agentId,
					toolCallId: currentCall.toolCallId,
					mode: 'fork',
					fork: { fromAgentId: dispatcher.agentId, atSeq: lastEntry.seq },
					model: snapshot.model,
					tools: realized.tools,
					hooks: snapshot.hooks,
					// Forks append no leading system message: the fold carries the caller's blocks (D21).
					systemPrompt: null,
					skillParam: input.skill,
					messages: preloaded === null ? [input.prompt] : [input.prompt, preloaded],
					launch: { _tag: 'start' },
					interruptNote,
				}).pipe(Effect.catchTag('SubagentBusyError', dieOnBusy))
			}),
		)

		const resume: SubagentsService['resume'] = Effect.fn('fold.subagents.resume')((input: ResumeSubagentInput) =>
			Effect.gen(function* () {
				const dispatcher = yield* CurrentAgent
				const currentCall = yield* CurrentToolCall
				const interruptNote = yield* InterruptNote

				const entries = yield* collectEntries
				// The wire carries a reference (full id or unique short prefix); resolve it against every
				// started agent before anything else. Ambiguity is a not-found carrying the candidates.
				const resolution = resolveAgentIdRef(agentIdsFromEntries(entries), input.agentId)
				if (resolution._tag === 'not-found') {
					return yield* new SubagentNotFoundError({ requested: input.agentId })
				}
				if (resolution._tag === 'ambiguous') {
					return yield* new SubagentNotFoundError({
						requested: input.agentId,
						candidates: resolution.candidates,
					})
				}
				const agentId = resolution.agentId

				const started = findAgentStarted(entries, agentId)
				if (started === null) {
					return yield* new SubagentNotFoundError({ requested: input.agentId })
				}

				// Resuming yourself or a running ancestor would run one agent's loop inside itself.
				if (agentId === dispatcher.agentId || ancestorAgentIds(entries, dispatcher.agentId).has(agentId)) {
					return yield* new SubagentBusyError({ agentId })
				}

				const dispatcherOrigin = originatingConfigForAgent(entries, dispatcher.agentId)
				const preloaded =
					input.skill === null
						? null
						: dispatcherOrigin === null
							? yield* new SkillNotFoundError({ name: input.skill, availableSkills: [] })
							: yield* preloadedSkillMessage(dispatcherOrigin, input.skill)

				// The resumed agent's binding: its registry entry when its type is (still) registered,
				// otherwise its fork-source chain, otherwise the dispatcher's own configuration.
				const targetOrigin = originatingConfigForAgent(entries, agentId) ?? dispatcherOrigin
				if (targetOrigin === null) {
					return yield* Effect.die(new Error(`resume target ${agentId} has no resolvable configuration`))
				}

				const snapshot = yield* agentSnapshotForOrigin(targetOrigin)
				const realized = config.realizeAgentTools(snapshot.tools)

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
					tools: realized.tools,
					hooks: snapshot.hooks,
					systemPrompt: null,
					skillParam: input.skill,
					messages: preloaded === null ? [input.prompt] : [input.prompt, preloaded],
					launch: { _tag: 'resume', modelTransition },
					interruptNote,
				})
			}),
		)

		return { dispatch, fork, resume, continueSubagent }
	})
