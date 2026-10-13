/**
 * This file implements SessionControls - the session-fixed control plane behind slice 2 (D8/D9/D10).
 * One instance per session owns three things every agent's loop and the public facade share:
 *
 * - The running-agent registry: who is running right now, with the run fiber once it exists. The
 *   facade claims the root's runs, the subagent operations claim dispatched children, and SDK
 *   continuations claim their target - so "is agent X running", targeted interrupt (D10), and the
 *   subagent Busy guard (D21) all read one source of truth.
 * - Per-agent steering and follow-up queues (D8). Both are ephemeral in-memory queues: a steered
 *   message is logged only at its drain point (between the target's turns), so the log records the
 *   message exactly when that model saw it; a follow-up drains when the target's run would complete
 *   naturally, and its ticket tells the sender whether the run ever consumed it. Releasing a running
 *   agent abandons whatever is still queued - undrained means never seen, never logged.
 * - The session-wide graceful-stop signal (D9): first-write-wins, observed by every agent's loop at
 *   its batch boundaries (root and subagents alike - the tree stops together), cleared by the facade
 *   when the next send begins.
 *
 * Queued messages may carry a user-message origin (background task notifications). Adjacent queued
 * task notifications drain as ONE message, so completions that land close together reach the model as
 * a single user turn.
 */
import { Array as Arr, Context, Deferred, Effect, type Exit, Fiber, Layer, Ref, SynchronizedRef } from 'effect'

import { TaskNotificationOrigin, type AgentFinishedLogEntry, type UserMessageOrigin } from '../EventLog/Schemas'
import type { AgentId } from '../Ids'
import { AgentNotRunningError } from './Errors'

/** How queued steering messages drain at a turn boundary (D8/pi): one per boundary, or all at once. */
export type SteeringMode = 'one-at-a-time' | 'all'

/** Handle for one queued follow-up message. */
export type FollowUpTicket = {
	/**
	 * Resolves true when the running agent drained the message into its run, false when that run ended
	 * without consuming it (stopped, errored, or interrupted first).
	 */
	readonly consumed: Effect.Effect<boolean>
}

/** One queued message as the agent loop appends it: its text and, for synthetic messages, its origin. */
export type QueuedUserMessage = {
	readonly text: string
	readonly origin: UserMessageOrigin | null
}

type FollowUpEntry = QueuedUserMessage & {
	readonly consumed: Deferred.Deferred<boolean>
}

type QueuedTaskNotification = QueuedUserMessage & { readonly origin: TaskNotificationOrigin }

const isTaskNotification = (message: QueuedUserMessage): message is QueuedTaskNotification =>
	message.origin?._tag === 'task-notification'

/**
 * Merge runs of adjacent task-notification messages into one message (texts joined, task ids
 * concatenated); every other message passes through in order.
 */
export const coalesceQueuedMessages = (
	messages: ReadonlyArray<QueuedUserMessage>,
): ReadonlyArray<QueuedUserMessage> => {
	const merged: Array<QueuedUserMessage> = []
	for (const message of messages) {
		const previous = merged.at(-1)
		if (previous !== undefined && isTaskNotification(previous) && isTaskNotification(message)) {
			merged[merged.length - 1] = {
				text: `${previous.text}\n\n${message.text}`,
				origin: TaskNotificationOrigin.make({
					taskIds: [...previous.origin.taskIds, ...message.origin.taskIds],
				}),
			}
			continue
		}
		merged.push(message)
	}
	return merged
}

/** The leading drain unit of a queue: one message, or a run of adjacent task notifications. */
const leadingGroupLength = (queued: ReadonlyArray<QueuedUserMessage>): number => {
	const first = queued[0]
	if (first === undefined) return 0
	if (!isTaskNotification(first)) return 1
	const end = queued.findIndex((message) => !isTaskNotification(message))
	return end === -1 ? queued.length : end
}

type RunningAgentRecord = {
	/** The run fiber; null between the claim and the fork. */
	readonly fiber: Fiber.Fiber<AgentFinishedLogEntry> | null
}

/** Session-wide run controls: running-agent registry, steering/follow-up queues, and the stop signal. */
export type SessionControlsService = {
	/** Atomically claim an agent as running; false when it already is (the Busy signal). */
	readonly claimRunning: (agentId: AgentId) => Effect.Effect<boolean>
	/** Attach the run fiber to a claimed agent so targeted interrupt and follow-up awaits can reach it. */
	readonly setRunningFiber: (agentId: AgentId, fiber: Fiber.Fiber<AgentFinishedLogEntry>) => Effect.Effect<void>
	/** Release a claim; abandons the agent's queued steering and follow-ups (undrained = never seen). */
	readonly releaseRunning: (agentId: AgentId) => Effect.Effect<void>
	readonly isRunning: (agentId: AgentId) => Effect.Effect<boolean>
	/** Snapshot of every agent currently claimed as running. */
	readonly runningAgentIds: Effect.Effect<ReadonlyArray<AgentId>>
	/** Await the current run's exit; null when the agent is not running (or its fiber is not attached yet). */
	readonly awaitRunning: (agentId: AgentId) => Effect.Effect<Exit.Exit<AgentFinishedLogEntry> | null>
	/** Interrupt one running agent's fiber and await its termination; false when it was not running. */
	readonly interruptRunning: (agentId: AgentId) => Effect.Effect<boolean>
	/** Interrupt every running agent (D10 session interrupt). */
	readonly interruptAllRunning: Effect.Effect<void>
	/** Queue a steering message for a RUNNING agent; drained between its turns (D8). */
	readonly steer: (
		agentId: AgentId,
		text: string,
		origin?: UserMessageOrigin,
	) => Effect.Effect<void, AgentNotRunningError>
	/**
	 * Pop queued steering per the session's steering mode; the loop appends each as a user message. In
	 * one-at-a-time mode a run of adjacent task notifications counts as one message.
	 */
	readonly drainSteering: (agentId: AgentId) => Effect.Effect<ReadonlyArray<QueuedUserMessage>>
	/** Queue a follow-up for a RUNNING agent; drained when its run would complete naturally (D8). */
	readonly pushFollowUp: (
		agentId: AgentId,
		text: string,
		origin?: UserMessageOrigin,
	) => Effect.Effect<FollowUpTicket, AgentNotRunningError>
	/** Pop ALL queued follow-ups (resolving their tickets true); the loop appends them and continues. */
	readonly drainFollowUps: (agentId: AgentId) => Effect.Effect<ReadonlyArray<QueuedUserMessage>>
	/** Request a session-wide graceful stop (D9); first reason wins until cleared. */
	readonly requestSessionStop: (reason: string) => Effect.Effect<void>
	readonly sessionStopReason: Effect.Effect<string | null>
	/** Clear the stop signal; the facade calls this as each new send begins. */
	readonly clearSessionStop: Effect.Effect<void>
}

/** SessionControls service tag; one instance per session, shared by every provisioned runtime. */
export class SessionControls extends Context.Service<SessionControls, SessionControlsService>()(
	'fold/SessionControls',
) {}

const notRunning = (agentId: AgentId): AgentNotRunningError =>
	new AgentNotRunningError({
		agentId,
		message:
			`Agent ${agentId} is not currently running. Steering only reaches a live run; ` +
			`use send(message, { agentId: "${agentId}" }) to continue a finished agent.`,
	})

/** One session's controls. `steeringMode` fixes how steering queues drain (D8). */
export const layerSessionControls = (options?: {
	readonly steeringMode?: SteeringMode
}): Layer.Layer<SessionControls> =>
	Layer.effect(
		SessionControls,
		Effect.gen(function* () {
			const steeringMode = options?.steeringMode ?? 'one-at-a-time'

			const running = yield* SynchronizedRef.make<ReadonlyMap<AgentId, RunningAgentRecord>>(new Map())
			const steering = yield* Ref.make<ReadonlyMap<AgentId, ReadonlyArray<QueuedUserMessage>>>(new Map())
			const followUps = yield* Ref.make<ReadonlyMap<AgentId, ReadonlyArray<FollowUpEntry>>>(new Map())
			const stopReason = yield* Ref.make<string | null>(null)

			const claimRunning = (agentId: AgentId): Effect.Effect<boolean> =>
				SynchronizedRef.modifyEffect(running, (current) =>
					current.has(agentId)
						? Effect.succeed([false, current] as const)
						: Effect.succeed([true, new Map(current).set(agentId, { fiber: null })] as const),
				)

			const setRunningFiber = (
				agentId: AgentId,
				fiber: Fiber.Fiber<AgentFinishedLogEntry>,
			): Effect.Effect<void> =>
				SynchronizedRef.modifyEffect(running, (current) => {
					const record = current.get(agentId)
					if (record === undefined) return Effect.succeed([undefined, current] as const)
					return Effect.succeed([undefined, new Map(current).set(agentId, { ...record, fiber })] as const)
				})

			/** Abandon one agent's queued follow-ups: resolve every ticket false and clear the queue. */
			const abandonFollowUps = (agentId: AgentId): Effect.Effect<void> =>
				Effect.gen(function* () {
					const queued = yield* Ref.modify(followUps, (current) => {
						const entries = current.get(agentId) ?? []
						const next = new Map(current)
						next.delete(agentId)
						return [entries, next] as const
					})
					yield* Effect.forEach(queued, (entry) => Deferred.succeed(entry.consumed, false), { discard: true })
				})

			const releaseRunning = (agentId: AgentId): Effect.Effect<void> =>
				Effect.gen(function* () {
					yield* SynchronizedRef.modifyEffect(running, (current) => {
						const next = new Map(current)
						next.delete(agentId)
						return Effect.succeed([undefined, next] as const)
					})
					yield* Ref.update(steering, (current) => {
						const next = new Map(current)
						next.delete(agentId)
						return next
					})
					yield* abandonFollowUps(agentId)
				})

			const isRunning = (agentId: AgentId): Effect.Effect<boolean> =>
				SynchronizedRef.get(running).pipe(Effect.map((current) => current.has(agentId)))

			const runningAgentIds: Effect.Effect<ReadonlyArray<AgentId>> = SynchronizedRef.get(running).pipe(
				Effect.map((current) => [...current.keys()]),
			)

			const awaitRunning = (agentId: AgentId): Effect.Effect<Exit.Exit<AgentFinishedLogEntry> | null> =>
				SynchronizedRef.get(running).pipe(
					Effect.flatMap((current) => {
						const fiber = current.get(agentId)?.fiber ?? null
						return fiber === null ? Effect.succeed(null) : Fiber.await(fiber)
					}),
				)

			const interruptRunning = (agentId: AgentId): Effect.Effect<boolean> =>
				SynchronizedRef.get(running).pipe(
					Effect.flatMap((current) => {
						const fiber = current.get(agentId)?.fiber ?? null
						return fiber === null ? Effect.succeed(false) : Fiber.interrupt(fiber).pipe(Effect.as(true))
					}),
				)

			const interruptAllRunning: Effect.Effect<void> = SynchronizedRef.get(running).pipe(
				Effect.flatMap((current) =>
					Effect.forEach([...current.keys()], (agentId) => interruptRunning(agentId), { discard: true }),
				),
			)

			const steer = (
				agentId: AgentId,
				text: string,
				origin?: UserMessageOrigin,
			): Effect.Effect<void, AgentNotRunningError> =>
				Effect.gen(function* () {
					if (!(yield* isRunning(agentId))) return yield* notRunning(agentId)
					yield* Ref.update(steering, (current) => {
						const queued = current.get(agentId) ?? []
						return new Map(current).set(agentId, [...queued, { text, origin: origin ?? null }])
					})
				})

			const drainSteering = (agentId: AgentId): Effect.Effect<ReadonlyArray<QueuedUserMessage>> =>
				Ref.modify(steering, (current) => {
					const queued = current.get(agentId) ?? []
					if (Arr.isReadonlyArrayEmpty(queued)) return [[], current] as const

					const take = steeringMode === 'all' ? queued.length : leadingGroupLength(queued)
					const drained = coalesceQueuedMessages(queued.slice(0, take))
					const remaining = queued.slice(take)
					const next = new Map(current)
					if (Arr.isReadonlyArrayEmpty(remaining)) next.delete(agentId)
					else next.set(agentId, remaining)
					return [drained, next] as const
				})

			const pushFollowUp = (
				agentId: AgentId,
				text: string,
				origin?: UserMessageOrigin,
			): Effect.Effect<FollowUpTicket, AgentNotRunningError> =>
				Effect.gen(function* () {
					if (!(yield* isRunning(agentId))) return yield* notRunning(agentId)
					const consumed = yield* Deferred.make<boolean>()
					yield* Ref.update(followUps, (current) => {
						const queued = current.get(agentId) ?? []
						return new Map(current).set(agentId, [...queued, { text, origin: origin ?? null, consumed }])
					})
					return { consumed: Deferred.await(consumed) }
				})

			const drainFollowUps = (agentId: AgentId): Effect.Effect<ReadonlyArray<QueuedUserMessage>> =>
				Effect.gen(function* () {
					const queued = yield* Ref.modify(followUps, (current) => {
						const entries = current.get(agentId) ?? []
						const next = new Map(current)
						next.delete(agentId)
						return [entries, next] as const
					})
					yield* Effect.forEach(queued, (entry) => Deferred.succeed(entry.consumed, true), { discard: true })
					return coalesceQueuedMessages(queued.map((entry) => ({ text: entry.text, origin: entry.origin })))
				})

			const requestSessionStop = (reason: string): Effect.Effect<void> =>
				Ref.update(stopReason, (current) => current ?? reason)

			return {
				claimRunning,
				setRunningFiber,
				releaseRunning,
				isRunning,
				runningAgentIds,
				awaitRunning,
				interruptRunning,
				interruptAllRunning,
				steer,
				drainSteering,
				pushFollowUp,
				drainFollowUps,
				requestSessionStop,
				sessionStopReason: Ref.get(stopReason),
				clearSessionStop: Ref.set(stopReason, null),
			}
		}),
	)
