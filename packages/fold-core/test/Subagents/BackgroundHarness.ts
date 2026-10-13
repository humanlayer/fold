/**
 * Harness for background-subagent tests: a scripted model whose turns can each wait on a gate, so a
 * test decides exactly when a root or background agent finishes a turn; plus small readers over the
 * session log. Turns that never get their gate released hang forever - the interruption target.
 */
import { Deferred, Effect, Predicate, Ref, Stream } from 'effect'
import { AiError, LanguageModel } from 'effect/ai'

import {
	customModel,
	encodedContentText,
	type ActiveModel,
	type BackgroundTask,
	type FoldModel,
	type FoldSession,
	type LogEntry,
	type TaskFinishedLogEntry,
	type TaskStartedLogEntry,
	type UserMessageLogEntry,
} from '../../src/index'
import type { ScriptedTurn } from '../TestLayers/ScriptedLanguageModel'

/** One scripted turn held until `gate` opens; `started` is signaled when it is requested. */
export type GatedTurn = {
	readonly _tag: 'gated'
	readonly turn: ScriptedTurn
	readonly gate: Deferred.Deferred<void> | null
	readonly started: Deferred.Deferred<void> | null
}

/** Hold a scripted turn until `gate` opens (never, if it never does); signal `started` on request. */
export const gatedTurn = (
	turn: ScriptedTurn,
	options: { readonly gate?: Deferred.Deferred<void>; readonly started?: Deferred.Deferred<void> },
): GatedTurn => ({ _tag: 'gated', turn, gate: options.gate ?? null, started: options.started ?? null })

export type GatedModel = {
	readonly model: FoldModel
	/** Append turns between sends (for params only known at runtime, like agent ids). */
	readonly push: (turns: ReadonlyArray<GatedTurn | ScriptedTurn>) => Effect.Effect<void>
	readonly requests: Effect.Effect<number>
}

/** A model serving its turns in order across every runtime provisioned from it; gated turns wait. */
export const makeGatedModel = (
	activeModel: ActiveModel,
	turns: ReadonlyArray<GatedTurn | ScriptedTurn>,
): Effect.Effect<GatedModel> =>
	Effect.gen(function* () {
		const normalize = (input: ReadonlyArray<GatedTurn | ScriptedTurn>): ReadonlyArray<GatedTurn> =>
			input.map((turn) => (Predicate.isTagged(turn, 'gated') ? turn : gatedTurn(turn, {})))
		const turnsRef = yield* Ref.make(normalize(turns))
		const requests = yield* Ref.make(0)

		const make = LanguageModel.make({
			generateText: () => Effect.die(new Error('gated model supports streamText only')),
			streamText: () =>
				Stream.unwrap(
					Effect.gen(function* () {
						yield* Ref.update(requests, (count) => count + 1)
						const remaining = yield* Ref.get(turnsRef)
						const next = remaining[0]
						if (next === undefined) return yield* Effect.die(new Error('gated model: script exhausted'))
						yield* Ref.set(turnsRef, remaining.slice(1))
						if (next.started !== null) yield* Deferred.succeed(next.started, undefined)
						if (next.gate !== null) yield* Deferred.await(next.gate)
						return Predicate.isTagged(next.turn, 'failure')
							? Stream.fail(
									AiError.make({
										module: 'GatedModel',
										method: 'streamText',
										reason: new AiError.UnknownError({ description: next.turn.message }),
									}),
								)
							: Stream.fromIterable(next.turn.parts)
					}),
				),
		})

		return {
			model: customModel({ activeModel, make }),
			push: (extra) => Ref.update(turnsRef, (remaining) => [...remaining, ...normalize(extra)]),
			requests: Ref.get(requests),
		}
	})

export const taskStartedRows = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<TaskStartedLogEntry> =>
	entries.filter((entry): entry is TaskStartedLogEntry => Predicate.isTagged(entry, 'task_started'))

export const taskFinishedRows = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<TaskFinishedLogEntry> =>
	entries.filter((entry): entry is TaskFinishedLogEntry => Predicate.isTagged(entry, 'task_finished'))

/** User messages the runtime wrote to deliver task notifications. */
export const notificationMessages = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<UserMessageLogEntry> =>
	entries.filter(
		(entry): entry is UserMessageLogEntry =>
			Predicate.isTagged(entry, 'user-message') && entry.origin?._tag === 'task-notification',
	)

export const messageText = (entry: UserMessageLogEntry): string => encodedContentText(entry.message.content)

/** The root's terminal rows, in log order. */
export const rootFinishedOutcomes = (entries: ReadonlyArray<LogEntry>, rootAgentId: string) =>
	entries.flatMap((entry) =>
		Predicate.isTagged(entry, 'agent-finished') && entry.agentId === rootAgentId ? [entry] : [],
	)

/** The text of every tool result in log order (JSON of its first content part). */
export const toolResultTexts = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<string> =>
	entries.flatMap((entry) =>
		Predicate.isTagged(entry, 'tool-result') ? [JSON.stringify(entry.message.content[0])] : [],
	)

/** Wait until the session's task list satisfies a predicate. */
export const awaitTasks = <R>(
	session: FoldSession<R>,
	predicate: (tasks: ReadonlyArray<BackgroundTask>) => boolean,
): Effect.Effect<void> => session.backgroundTaskChanges.pipe(Stream.filter(predicate), Stream.take(1), Stream.runDrain)
