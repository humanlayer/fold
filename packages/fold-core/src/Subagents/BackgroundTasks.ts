/**
 * This file implements BackgroundTasks - one session's registry of background subagent runs and the
 * delivery of their completions. It is the deep module behind `subagent { run_in_background: true }`:
 *
 * - Lifetime. Each run gets its own scope forked from the session scope. The subagent's claim, its
 *   provisioned runtime, and its run fiber live there, so the launching tool call returns at once and
 *   the run outlives it. Closing the session closes every task scope, which interrupts the run.
 * - Durable record. `task_started` lands after the agent's own start rows and before its first message;
 *   `task_finished` is written by an uninterruptible exit finalizer on the run fiber, so a run that
 *   completes, fails, is stopped, or is torn down by session close always gets one.
 * - Live record. A SubscriptionRef holds every task (running and finished) for snapshots and change
 *   streams; a watcher folds the task agent's assistant messages into turns, tool uses, tokens, and the
 *   last tool name, and publishes them as ephemeral `task-progress` deltas.
 * - Notification. When a run ends, its `<task-notification>` is queued for the agent that launched it.
 *   `serveNotifications` delivers queued notifications: to a running launcher as a follow-up (at its
 *   natural completion), otherwise to the root agent - as a follow-up when the root is running, or by
 *   waking it with a new run when it is idle. Everything pending when a wake takes the root's gate goes
 *   into that one wake, and adjacent queued notifications coalesce into one user message.
 * - Stop. A stop interrupts one run's fiber. The stop notice decides how its notification travels:
 *   `notify` wakes the launcher like any completion, `defer` holds it for the root's next run (session
 *   stop), and `silent` drops it (the launcher stopped the task itself and already knows).
 */
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Match,
	Predicate,
	Queue,
	Ref,
	Scope,
	Stream,
	SubscriptionRef,
} from 'effect'

import { AgentEvents } from '../AgentEvents/AgentEventsService'
import { EventLog } from '../EventLog/EventLogService'
import { encodedContentParts, encodedContentText, isPartOfType } from '../EventLog/MessageContent'
import {
	LogEntryInputs,
	type AgentFinishedLogEntry,
	type AssistantMessageLogEntry,
	type BackgroundTaskFinalStatus,
	type BackgroundTaskUsage,
	type LogEntry,
	type LogSeq,
	type TaskFinishedLogEntry,
	type TaskStartedLogEntry,
	TaskNotificationOrigin,
} from '../EventLog/Schemas'
import { usageInputTotal, usageOutputTotal } from '../EventLog/Usage'
import type { AgentId, ToolCallId } from '../Ids'
import { SessionControls, type QueuedUserMessage } from '../Session/SessionControls'
import { modelVisibleErrorDetailsFromCause } from '../ToolRuntime/ModelVisibleErrors'
import { shortAgentId } from './AgentIdRef'

/** Status of a background task: running, or how its latest run ended. */
export type BackgroundTaskStatus = 'running' | BackgroundTaskFinalStatus

/**
 * One background task as hosts and tools see it. The task id is the background agent's id; a task
 * keeps its id across runs (a resume starts a new run and bumps `runCount`).
 */
export type BackgroundTask = {
	readonly taskId: AgentId
	/** The tool call that launched the latest run (a subagent call, or a send_message resume). */
	readonly toolCallId: ToolCallId
	/** The agent that launched the latest run; it is notified when the run ends. */
	readonly parentAgentId: AgentId
	readonly taskType: 'subagent'
	/** Registry type name; null for forks. */
	readonly agentType: string | null
	readonly description: string
	/** The message the latest run started with. */
	readonly prompt: string
	readonly status: BackgroundTaskStatus
	readonly isBackgrounded: boolean
	/** Epoch millis when the latest run started. */
	readonly startedAt: number
	/** Epoch millis when the latest run ended; null while running. */
	readonly endedAt: number | null
	/** Epoch millis when the latest run's notification was handed to its launcher; null until then. */
	readonly notifiedAt: number | null
	readonly usage: BackgroundTaskUsage
	readonly lastToolName: string | null
	/** The task agent's latest assistant text (truncated) while it runs. */
	readonly progressSummary: string | null
	/** The latest run's final assistant text. */
	readonly summary: string | null
	readonly error: string | null
	readonly runCount: number
}

/** Who launched a background run, and what it was asked to do. */
export type LaunchBackgroundTaskInput = {
	readonly taskId: AgentId
	readonly parentAgentId: AgentId
	readonly toolCallId: ToolCallId
	readonly agentType: string | null
	readonly description: string
	readonly prompt: string
}

/** A prepared run: the agent is claimed and started; forking `run` executes it. */
export type PreparedRun = { readonly run: Effect.Effect<AgentFinishedLogEntry> }

/** How a stopped run's notification travels: wake the launcher, hold it for the next root run, or drop it. */
export type TaskStopNotice = 'notify' | 'defer' | 'silent'

/** Hands one wake's message (taken at the root's gate) to a fresh root run; null means nothing to deliver. */
export type RootWake = (take: Effect.Effect<QueuedUserMessage | null>) => Effect.Effect<void>

export type BackgroundTasksService = {
	/**
	 * Start one background run. `prepare` runs in the new task scope and returns the agent's run
	 * effect: it claims the agent, provisions its runtime, and writes its start rows. A failure of
	 * `prepare` (a busy agent) closes the task scope and propagates; nothing is recorded.
	 */
	readonly launch: <E, R>(
		input: LaunchBackgroundTaskInput,
		prepare: Effect.Effect<PreparedRun, E, R>,
	) => Effect.Effect<BackgroundTask, E, Exclude<R, Scope.Scope>>
	/** Every task this session has seen (running and finished), in first-launch order. */
	readonly list: Effect.Effect<ReadonlyArray<BackgroundTask>>
	/** The task list now, then after every change. */
	readonly changes: Stream.Stream<ReadonlyArray<BackgroundTask>>
	readonly get: (taskId: AgentId) => Effect.Effect<BackgroundTask | null>
	/** Interrupt one running task and wait for its durable end; false when it was not running. */
	readonly stop: (taskId: AgentId, notice: TaskStopNotice) => Effect.Effect<boolean>
	/** Stop every running task. */
	readonly stopAll: (notice: TaskStopNotice) => Effect.Effect<void>
	/** Wait until the task's latest run has fully released its agent (no-op when not running). */
	readonly awaitSettled: (taskId: AgentId) => Effect.Effect<void>
	/**
	 * Adopt a resumed log: rebuild the registry from its task rows, and close any run the previous
	 * process left open with a `stopped` task_finished whose notification waits for the next root run.
	 */
	readonly hydrate: (entries: ReadonlyArray<LogEntry>) => Effect.Effect<void>
	/** Deliver queued notifications forever. The session handle forks this into the session scope. */
	readonly serveNotifications: (options: {
		readonly rootAgentId: AgentId
		readonly wake: RootWake
	}) => Effect.Effect<never>
	/** Re-check queued notifications now (the root just started a run, or a stop request was cleared). */
	readonly nudge: Effect.Effect<void>
	/**
	 * Resolve once no task is running, no wake run is scheduled or running, and every queued
	 * notification has been delivered (deferred ones excepted: they wait for the next root run).
	 */
	readonly awaitIdle: Effect.Effect<void>
}

/** BackgroundTasks service tag; one instance per session, shared by the engine, tools, and handle. */
export class BackgroundTasks extends Context.Service<BackgroundTasks, BackgroundTasksService>()(
	'fold/BackgroundTasks',
) {}

/** One finished run waiting for delivery. */
type TaskNotification = {
	readonly taskId: AgentId
	readonly parentAgentId: AgentId
	readonly text: string
	/** Deliver only alongside a root run someone else started; never wakes the root by itself. */
	readonly deferred: boolean
}

type State = {
	readonly tasks: ReadonlyArray<BackgroundTask>
	readonly pending: ReadonlyArray<TaskNotification>
	/** Notifications handed to a running agent whose consumption is not yet confirmed. */
	readonly inFlight: number
	/** A wake run is waiting for the root's gate or running. */
	readonly waking: boolean
	/**
	 * Runs that have not settled yet: launched, and their notification not yet queued. A run's
	 * task_finished row lands before its scope closes and its notification is queued, so "no task is
	 * running" alone would report idle in that window.
	 */
	readonly unsettled: ReadonlyArray<AgentId>
}

/** Per-run control state, kept only while the run's scope is open. */
type ActiveRun = {
	readonly stopNotice: Ref.Ref<TaskStopNotice>
	readonly settled: Deferred.Deferred<void>
}

const PROGRESS_SUMMARY_LENGTH = 200
const NOTIFICATION_RESULT_LENGTH = 20_000

const emptyUsage: BackgroundTaskUsage = { turns: 0, toolUses: 0, totalTokens: null }

/** Progress of one run so far: work done, last tool, and latest assistant text. */
type RunProgress = {
	readonly usage: BackgroundTaskUsage
	readonly lastToolName: string | null
	readonly text: string | null
}

const emptyProgress: RunProgress = { usage: emptyUsage, lastToolName: null, text: null }

const truncate = (text: string, length: number): string =>
	text.length <= length ? text : `${text.slice(0, length)}... [truncated]`

/** Fold one of the task agent's assistant messages into its run progress. */
const foldAssistantTurn = (progress: RunProgress, entry: AssistantMessageLogEntry): RunProgress => {
	const toolCalls = encodedContentParts(entry.message.content).filter(isPartOfType('tool-call'))
	const text = encodedContentText(entry.message.content).trim()
	const usage = entry.finish?.usage
	return {
		usage: {
			turns: progress.usage.turns + 1,
			toolUses: progress.usage.toolUses + toolCalls.length,
			totalTokens:
				usage === undefined
					? progress.usage.totalTokens
					: Math.round(usageInputTotal(usage) + usageOutputTotal(usage)),
		},
		lastToolName: toolCalls.at(-1)?.name ?? progress.lastToolName,
		text: text.length > 0 ? text : progress.text,
	}
}

const isRunTurn =
	(taskId: AgentId, afterSeq: LogSeq) =>
	(entry: LogEntry): entry is AssistantMessageLogEntry =>
		Predicate.isTagged(entry, 'assistant-message') && entry.agentId === taskId && entry.seq > afterSeq

/** Progress of one run, folded from the log: the task agent's own turns after its task_started row. */
const progressForRun = (entries: ReadonlyArray<LogEntry>, taskId: AgentId, afterSeq: LogSeq) =>
	entries.filter(isRunTurn(taskId, afterSeq)).reduce(foldAssistantTurn, emptyProgress)

/** How a run ended, from its fiber exit: the durable terminal entry, or the cause that tore it down. */
const finalStatusFor = (
	exit: Exit.Exit<AgentFinishedLogEntry>,
): {
	readonly status: BackgroundTaskFinalStatus
	readonly error: string | null
	readonly resultText: string | null
} => {
	if (Exit.isFailure(exit)) {
		return Cause.hasInterrupts(exit.cause)
			? { status: 'stopped', error: null, resultText: null }
			: { status: 'failed', error: modelVisibleErrorDetailsFromCause(exit.cause), resultText: null }
	}
	const finished = exit.value
	return Match.value(finished.outcome).pipe(
		Match.when('completed', () => ({ status: 'completed' as const, error: null, resultText: finished.resultText })),
		Match.when('error', () => ({
			status: 'failed' as const,
			error: finished.reason,
			resultText: finished.resultText,
		})),
		Match.whenOr('stopped', 'interrupted', () => ({
			status: 'stopped' as const,
			error: null,
			resultText: finished.resultText,
		})),
		Match.exhaustive,
	)
}

const statusPhrase = (status: BackgroundTaskFinalStatus): string =>
	Match.value(status).pipe(
		Match.when('completed', () => 'completed'),
		Match.when('failed', () => 'failed'),
		Match.when('stopped', () => 'was stopped'),
		Match.exhaustive,
	)

/** The `<task-notification>` block the launcher reads when a run ends. */
export const renderTaskNotification = (task: BackgroundTask): string => {
	const status = task.status === 'running' ? 'completed' : task.status
	const id = shortAgentId(task.taskId)
	const lines = [
		'<task-notification>',
		`<task-id>${id}</task-id>`,
		`<status>${status}</status>`,
		`<summary>Background agent "${task.description}" ${statusPhrase(status)}</summary>`,
	]
	if (task.summary !== null) lines.push(`<result>\n${truncate(task.summary, NOTIFICATION_RESULT_LENGTH)}\n</result>`)
	if (task.error !== null) lines.push(`<error>${task.error}</error>`)
	lines.push(
		`<usage>turns: ${task.usage.turns}, tool uses: ${task.usage.toolUses}</usage>`,
		`<note>The agent keeps its context. Send it a message with agent_id ${id} to continue it.</note>`,
		'</task-notification>',
	)
	return lines.join('\n')
}

const notificationMessage = (notifications: ReadonlyArray<TaskNotification>): QueuedUserMessage => ({
	text: notifications.map((notification) => notification.text).join('\n\n'),
	origin: TaskNotificationOrigin.make({ taskIds: notifications.map((notification) => notification.taskId) }),
})

const replaceTask = (
	tasks: ReadonlyArray<BackgroundTask>,
	taskId: AgentId,
	update: (task: BackgroundTask) => BackgroundTask,
): ReadonlyArray<BackgroundTask> => tasks.map((task) => (task.taskId === taskId ? update(task) : task))

const upsertTask = (tasks: ReadonlyArray<BackgroundTask>, next: BackgroundTask): ReadonlyArray<BackgroundTask> =>
	tasks.some((task) => task.taskId === next.taskId) ? replaceTask(tasks, next.taskId, () => next) : [...tasks, next]

const taskFromStarted = (started: TaskStartedLogEntry, previous: BackgroundTask | undefined): BackgroundTask => ({
	taskId: started.agentId,
	toolCallId: started.toolCallId,
	parentAgentId: started.parentAgentId,
	taskType: started.taskType,
	agentType: started.agentType,
	description: started.description,
	prompt: started.prompt,
	status: 'running',
	isBackgrounded: started.isBackgrounded,
	startedAt: started.ts,
	endedAt: null,
	notifiedAt: null,
	usage: emptyUsage,
	lastToolName: null,
	progressSummary: null,
	summary: previous?.summary ?? null,
	error: null,
	runCount: started.runCount,
})

const applyFinished = (task: BackgroundTask, finished: TaskFinishedLogEntry): BackgroundTask => ({
	...task,
	status: finished.status,
	endedAt: finished.ts,
	usage: finished.usage,
	lastToolName: finished.lastToolName,
	progressSummary: null,
	summary: finished.summary,
	error: finished.error,
})

/**
 * True when an agent is a running background task or runs somewhere beneath one (a foreground
 * subagent of a background task). A root-only interrupt leaves these alone.
 */
export const isOwnedByBackgroundTask = (
	entries: ReadonlyArray<LogEntry>,
	agentId: AgentId,
	runningTaskIds: ReadonlySet<AgentId>,
): boolean => {
	const seen = new Set<AgentId>()
	let current: AgentId | null = agentId
	while (current !== null && !seen.has(current)) {
		if (runningTaskIds.has(current)) return true
		seen.add(current)
		const id: AgentId = current
		const started = entries.find((entry) => Predicate.isTagged(entry, 'agent_started') && entry.agentId === id)
		current = started === undefined ? null : started.parentAgentId
	}
	return false
}

/** The live layer. Built into the session scope, which owns every task scope and delivery fiber. */
export const layerBackgroundTasks: Layer.Layer<BackgroundTasks, never, EventLog | SessionControls | AgentEvents> =
	Layer.effect(
		BackgroundTasks,
		Effect.gen(function* () {
			const sessionScope = yield* Effect.scope
			const eventLog = yield* EventLog
			const controls = yield* SessionControls
			const agentEvents = yield* AgentEvents

			const state = yield* SubscriptionRef.make<State>({
				tasks: [],
				pending: [],
				inFlight: 0,
				waking: false,
				unsettled: [],
			})
			const activeRuns = yield* Ref.make<ReadonlyMap<AgentId, ActiveRun>>(new Map())
			const kicks = yield* Queue.sliding<void>(1)

			const collectEntries: Effect.Effect<ReadonlyArray<LogEntry>> = Stream.runCollect(eventLog.entries()).pipe(
				Effect.orDie,
				Effect.map((entries): ReadonlyArray<LogEntry> => entries),
			)
			const kick: Effect.Effect<void> = Queue.offer(kicks, undefined).pipe(Effect.asVoid)
			const updateState = (f: (current: State) => State): Effect.Effect<void> => SubscriptionRef.update(state, f)
			const getTask = (taskId: AgentId): Effect.Effect<BackgroundTask | null> =>
				SubscriptionRef.get(state).pipe(
					Effect.map((current) => current.tasks.find((task) => task.taskId === taskId) ?? null),
				)

			/** Fold the task agent's turns into live progress as they land, publishing each as a delta. */
			const watchProgress = (task: BackgroundTask, startedSeq: LogSeq): Effect.Effect<void> =>
				eventLog.subscribe(startedSeq + 1).pipe(
					Stream.orDie,
					Stream.filter(isRunTurn(task.taskId, startedSeq)),
					Stream.runFoldEffect(
						() => emptyProgress,
						(progress, entry) => {
							const next = foldAssistantTurn(progress, entry)
							const progressSummary =
								next.text === null ? null : truncate(next.text, PROGRESS_SUMMARY_LENGTH)
							return updateState((current) => ({
								...current,
								tasks: replaceTask(current.tasks, task.taskId, (existing) =>
									existing.status === 'running'
										? {
												...existing,
												usage: next.usage,
												lastToolName: next.lastToolName,
												progressSummary,
											}
										: existing,
								),
							})).pipe(
								Effect.andThen(
									agentEvents.publish({
										kind: 'delta',
										agentId: task.taskId,
										parentAgentId: task.parentAgentId,
										toolCallId: task.toolCallId,
										part: {
											type: 'task-progress',
											taskId: task.taskId,
											turns: next.usage.turns,
											toolUses: next.usage.toolUses,
											totalTokens: next.usage.totalTokens,
											lastToolName: next.lastToolName,
											progressSummary,
										},
									}),
								),
								Effect.as(next),
							)
						},
					),
					Effect.asVoid,
				)

			/** Uninterruptible run-exit finalizer: the durable task_finished row and the live record. */
			const finishRun =
				(task: BackgroundTask, startedSeq: LogSeq) =>
				(exit: Exit.Exit<AgentFinishedLogEntry>): Effect.Effect<void> =>
					Effect.gen(function* () {
						const entries = yield* collectEntries
						const progress = progressForRun(entries, task.taskId, startedSeq)
						const ending = finalStatusFor(exit)
						const endedAt = yield* Clock.currentTimeMillis
						const finished = yield* eventLog
							.append(
								LogEntryInputs.task_finished({
									agentId: task.taskId,
									parentAgentId: task.parentAgentId,
									toolCallId: task.toolCallId,
									status: ending.status,
									summary: ending.resultText ?? progress.text,
									error: ending.error,
									usage: progress.usage,
									durationMs: Math.max(0, endedAt - task.startedAt),
									lastToolName: progress.lastToolName,
								}),
							)
							.pipe(Effect.orDie)
						if (!Predicate.isTagged(finished, 'task_finished')) {
							return yield* Effect.die(new Error(`EventLog returned ${finished._tag} for task_finished`))
						}
						yield* updateState((current) => ({
							...current,
							tasks: replaceTask(current.tasks, task.taskId, (existing) =>
								applyFinished(existing, finished),
							),
						}))
					})

			const launch = <E, R>(
				input: LaunchBackgroundTaskInput,
				prepare: Effect.Effect<PreparedRun, E, R>,
			): Effect.Effect<BackgroundTask, E, Exclude<R, Scope.Scope>> =>
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const taskScope = yield* Scope.fork(sessionScope)
						const { run } = yield* restore(prepare).pipe(
							Scope.provide(taskScope),
							Effect.onExit((exit) =>
								Exit.isSuccess(exit) ? Effect.void : Scope.close(taskScope, exit),
							),
						)

						const previous = yield* getTask(input.taskId)
						const started = yield* eventLog
							.append(
								LogEntryInputs.task_started({
									agentId: input.taskId,
									parentAgentId: input.parentAgentId,
									toolCallId: input.toolCallId,
									taskType: 'subagent',
									agentType: input.agentType,
									description: input.description,
									prompt: input.prompt,
									isBackgrounded: true,
									runCount: previous === null ? 1 : previous.runCount + 1,
								}),
							)
							.pipe(Effect.orDie)
						if (!Predicate.isTagged(started, 'task_started')) {
							return yield* Effect.die(new Error(`EventLog returned ${started._tag} for task_started`))
						}
						const task = taskFromStarted(started, previous ?? undefined)
						yield* updateState((current) => ({
							...current,
							tasks: upsertTask(current.tasks, task),
							unsettled: [...current.unsettled, task.taskId],
						}))

						const activeRun: ActiveRun = {
							stopNotice: yield* Ref.make<TaskStopNotice>('notify'),
							settled: yield* Deferred.make<void>(),
						}
						yield* Ref.update(activeRuns, (current) => new Map(current).set(task.taskId, activeRun))

						yield* watchProgress(task, started.seq).pipe(Effect.forkIn(taskScope))
						const runFiber = yield* run.pipe(
							Effect.onExit(finishRun(task, started.seq)),
							Effect.forkIn(taskScope),
						)
						// Closing the task scope (session close) interrupts the run and waits for its finalizers,
						// so the durable markers land before the session's services go away.
						yield* Scope.addFinalizer(taskScope, Fiber.interrupt(runFiber))
						yield* controls.setRunningFiber(task.taskId, runFiber)

						// Settle the run: release its scope (the agent's claim and runtime) BEFORE the notification
						// is queued, so a launcher woken by it can immediately resume the same agent.
						yield* Effect.gen(function* () {
							yield* Fiber.await(runFiber)
							yield* Scope.close(taskScope, Exit.void)
							const notice = yield* Ref.get(activeRun.stopNotice)
							yield* Ref.update(activeRuns, (current) => {
								const next = new Map(current)
								next.delete(task.taskId)
								return next
							})
							// Queue the notification and mark the run settled in one update, so an idle check never
							// sees the run finished with nothing queued for it.
							yield* updateState((current) => {
								const ended = current.tasks.find((candidate) => candidate.taskId === task.taskId)
								const notification: ReadonlyArray<TaskNotification> =
									ended === undefined || notice === 'silent'
										? []
										: [
												{
													taskId: ended.taskId,
													parentAgentId: ended.parentAgentId,
													text: renderTaskNotification(ended),
													deferred: notice === 'defer',
												},
											]
								return {
									...current,
									pending: [...current.pending, ...notification],
									unsettled: current.unsettled.filter((taskId) => taskId !== task.taskId),
								}
							})
							yield* kick
							yield* Deferred.succeed(activeRun.settled, undefined)
						}).pipe(Effect.forkIn(sessionScope))

						return task
					}),
				)

			const stop = (taskId: AgentId, notice: TaskStopNotice): Effect.Effect<boolean> =>
				Effect.gen(function* () {
					const run = (yield* Ref.get(activeRuns)).get(taskId)
					if (run === undefined) return false
					yield* Ref.set(run.stopNotice, notice)
					return yield* controls.interruptRunning(taskId)
				})

			const stopAll = (notice: TaskStopNotice): Effect.Effect<void> =>
				Ref.get(activeRuns).pipe(
					Effect.flatMap((runs) =>
						Effect.forEach([...runs.keys()], (taskId) => stop(taskId, notice), {
							concurrency: 'unbounded',
							discard: true,
						}),
					),
				)

			const awaitSettled = (taskId: AgentId): Effect.Effect<void> =>
				Ref.get(activeRuns).pipe(
					Effect.flatMap((runs) => {
						const run = runs.get(taskId)
						return run === undefined ? Effect.void : Deferred.await(run.settled)
					}),
				)

			const hydrate = (entries: ReadonlyArray<LogEntry>): Effect.Effect<void> =>
				Effect.gen(function* () {
					let tasks: ReadonlyArray<BackgroundTask> = []
					const openRuns = new Map<AgentId, TaskStartedLogEntry>()
					for (const entry of entries) {
						if (Predicate.isTagged(entry, 'task_started')) {
							const previous = tasks.find((task) => task.taskId === entry.agentId)
							tasks = upsertTask(tasks, taskFromStarted(entry, previous))
							openRuns.set(entry.agentId, entry)
						} else if (Predicate.isTagged(entry, 'task_finished')) {
							tasks = replaceTask(tasks, entry.agentId, (task) => applyFinished(task, entry))
							openRuns.delete(entry.agentId)
						}
					}

					// A run the previous process never finished: record it stopped, and tell the launcher on
					// the root's next run.
					const orphaned: Array<TaskNotification> = []
					for (const started of openRuns.values()) {
						const progress = progressForRun(entries, started.agentId, started.seq)
						const finished = yield* eventLog
							.append(
								LogEntryInputs.task_finished({
									agentId: started.agentId,
									parentAgentId: started.parentAgentId,
									toolCallId: started.toolCallId,
									status: 'stopped',
									summary: progress.text,
									error: 'The session ended before this background agent finished.',
									usage: progress.usage,
									durationMs: 0,
									lastToolName: progress.lastToolName,
								}),
							)
							.pipe(Effect.orDie)
						if (!Predicate.isTagged(finished, 'task_finished')) continue
						tasks = replaceTask(tasks, started.agentId, (task) => applyFinished(task, finished))
						const task = tasks.find((candidate) => candidate.taskId === started.agentId)
						if (task !== undefined) {
							orphaned.push({
								taskId: task.taskId,
								parentAgentId: task.parentAgentId,
								text: renderTaskNotification(task),
								deferred: true,
							})
						}
					}

					yield* updateState((current) => ({ ...current, tasks, pending: [...current.pending, ...orphaned] }))
				})

			/** Hand notifications to a running agent as one follow-up; requeue them if its run ends first. */
			const deliverAsFollowUp = (
				agentId: AgentId,
				notifications: ReadonlyArray<TaskNotification>,
				requeueTo: AgentId,
			): Effect.Effect<void> =>
				Effect.gen(function* () {
					const message = notificationMessage(notifications)
					const ticket = yield* controls
						.pushFollowUp(agentId, message.text, message.origin ?? undefined)
						.pipe(Effect.catchTag('AgentNotRunningError', () => Effect.succeed(null)))
					if (ticket === null) {
						yield* updateState((current) => ({
							...current,
							pending: [
								...notifications.map((notification) => ({ ...notification, parentAgentId: requeueTo })),
								...current.pending,
							],
						}))
						return yield* kick
					}
					yield* markNotified(notifications)
					yield* updateState((current) => ({ ...current, inFlight: current.inFlight + 1 }))
					yield* ticket.consumed.pipe(
						Effect.flatMap((consumed) =>
							updateState((current) => ({
								...current,
								inFlight: current.inFlight - 1,
								pending: consumed
									? current.pending
									: [
											...notifications.map((notification) => ({
												...notification,
												parentAgentId: requeueTo,
											})),
											...current.pending,
										],
							})).pipe(Effect.andThen(consumed ? Effect.void : kick)),
						),
						Effect.forkIn(sessionScope),
					)
				})

			const markNotified = (notifications: ReadonlyArray<TaskNotification>): Effect.Effect<void> =>
				Clock.currentTimeMillis.pipe(
					Effect.flatMap((now) =>
						updateState((current) => ({
							...current,
							tasks: current.tasks.map((task) =>
								notifications.some((notification) => notification.taskId === task.taskId)
									? { ...task, notifiedAt: now }
									: task,
							),
						})),
					),
				)

			/** Take the pending notifications matching a predicate, leaving the rest queued. */
			const takePending = (
				predicate: (notification: TaskNotification) => boolean,
			): Effect.Effect<ReadonlyArray<TaskNotification>> =>
				SubscriptionRef.modify(state, (current) => {
					const [taken, kept] = [
						current.pending.filter(predicate),
						current.pending.filter((notification) => !predicate(notification)),
					]
					return [taken, { ...current, pending: kept }] as const
				})

			const deliverPending = (rootAgentId: AgentId, wake: RootWake): Effect.Effect<void> =>
				Effect.gen(function* () {
					const current = yield* SubscriptionRef.get(state)
					if (Arr.isReadonlyArrayEmpty(current.pending)) return

					// A launcher that is still running hears about its own tasks directly.
					const running = new Set(yield* controls.runningAgentIds)
					const launchers = [
						...new Set(
							current.pending
								.filter(
									(notification) =>
										!notification.deferred &&
										notification.parentAgentId !== rootAgentId &&
										running.has(notification.parentAgentId),
								)
								.map((notification) => notification.parentAgentId),
						),
					]
					for (const launcher of launchers) {
						const taken = yield* takePending(
							(notification) => !notification.deferred && notification.parentAgentId === launcher,
						)
						if (Arr.isReadonlyArrayNonEmpty(taken)) yield* deliverAsFollowUp(launcher, taken, rootAgentId)
					}

					// Everything else goes to the root.
					if (running.has(rootAgentId)) {
						const deferred = yield* takePending((notification) => notification.deferred)
						if (Arr.isReadonlyArrayNonEmpty(deferred)) {
							const message = notificationMessage(deferred)
							const steered = yield* controls
								.steer(rootAgentId, message.text, message.origin ?? undefined)
								.pipe(
									Effect.as(true),
									Effect.catchTag('AgentNotRunningError', () => Effect.succeed(false)),
								)
							if (steered) yield* markNotified(deferred)
							else yield* updateState((state) => ({ ...state, pending: [...deferred, ...state.pending] }))
						}
						const live = yield* takePending(() => true)
						if (Arr.isReadonlyArrayNonEmpty(live)) yield* deliverAsFollowUp(rootAgentId, live, rootAgentId)
						return
					}

					const after = yield* SubscriptionRef.get(state)
					if (after.waking || !after.pending.some((notification) => !notification.deferred)) return

					yield* updateState((state) => ({ ...state, waking: true }))
					const take: Effect.Effect<QueuedUserMessage | null> = takePending(() => true).pipe(
						Effect.tap(markNotified),
						Effect.map((taken) => (Arr.isReadonlyArrayEmpty(taken) ? null : notificationMessage(taken))),
					)
					yield* wake(take).pipe(
						Effect.ensuring(
							updateState((state) => ({ ...state, waking: false })).pipe(Effect.andThen(kick)),
						),
						Effect.forkIn(sessionScope),
					)
				})

			const serveNotifications = (options: {
				readonly rootAgentId: AgentId
				readonly wake: RootWake
			}): Effect.Effect<never> =>
				Queue.take(kicks).pipe(
					Effect.andThen(deliverPending(options.rootAgentId, options.wake)),
					Effect.forever,
				)

			const isIdle = (current: State): boolean =>
				!current.waking &&
				current.inFlight === 0 &&
				Arr.isReadonlyArrayEmpty(current.unsettled) &&
				current.tasks.every((task) => task.status !== 'running') &&
				current.pending.every((notification) => notification.deferred)

			const awaitIdle: Effect.Effect<void> = SubscriptionRef.changes(state).pipe(
				Stream.filter(isIdle),
				Stream.take(1),
				Stream.runDrain,
			)

			return {
				launch,
				list: SubscriptionRef.get(state).pipe(Effect.map((current) => current.tasks)),
				changes: SubscriptionRef.changes(state).pipe(
					Stream.map((current) => current.tasks),
					Stream.changes,
				),
				get: getTask,
				stop,
				stopAll,
				awaitSettled,
				hydrate,
				serveNotifications,
				nudge: kick,
				awaitIdle,
			}
		}),
	)
