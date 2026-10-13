/**
 * Headless runs and background agents: `settleBackgroundWork` keeps a `--prompt` run open until
 * background agents and the notification turns they trigger are done, returns the root's latest
 * outcome, and stops agents that outlive the timeout. Real fold-core sessions over a scripted model.
 */
import { expect, it } from '@effect/vitest'
import {
	customModel,
	defineAgent,
	defineSubagent,
	Session,
	subagentTool,
	type ActiveModel,
	type FoldModel,
} from '@humanlayer/fold-core'
import { Deferred, Duration, Effect, Fiber, Ref, Stream } from 'effect'
import { LanguageModel, type Response } from 'effect/ai'
import { TestClock } from 'effect/testing'

import { settleBackgroundWork } from '../src/Run'

const activeModel: ActiveModel = {
	providerId: 'scripted',
	providerKind: 'openai-compatible',
	modelId: 'scripted',
	role: null,
	requestedReasoningLevel: 'off',
	reasoning: { _tag: 'disabled' },
}

const finish = (reason: Response.FinishReason): Response.StreamPartEncoded => ({
	type: 'finish',
	reason,
	response: undefined,
	usage: {
		inputTokens: { uncached: undefined, total: 10, cacheRead: undefined, cacheWrite: undefined },
		outputTokens: { total: 5, text: undefined, reasoning: undefined },
	},
})

type Turn = { readonly parts: ReadonlyArray<Response.StreamPartEncoded>; readonly gate: Deferred.Deferred<void> | null }

const text = (value: string, gate: Deferred.Deferred<void> | null = null): Turn => ({
	parts: [
		{ type: 'text-start', id: 't' },
		{ type: 'text-delta', id: 't', delta: value },
		{ type: 'text-end', id: 't' },
		finish('stop'),
	],
	gate,
})

const launchInBackground: Turn = {
	parts: [
		{
			type: 'tool-call',
			id: 'call-1',
			name: 'subagent',
			params: { agent: 'worker', description: 'slow work', prompt: 'work', run_in_background: true },
			providerExecuted: false,
		},
		finish('tool-calls'),
	],
	gate: null,
}

const scripted = (turns: ReadonlyArray<Turn>): Effect.Effect<FoldModel> =>
	Effect.gen(function* () {
		const remaining = yield* Ref.make(turns)
		const make = LanguageModel.make({
			generateText: () => Effect.die(new Error('streamText only')),
			streamText: () =>
				Stream.unwrap(
					Effect.gen(function* () {
						const [next, ...rest] = yield* Ref.get(remaining)
						if (next === undefined) return yield* Effect.die(new Error('script exhausted'))
						yield* Ref.set(remaining, rest)
						if (next.gate !== null) yield* Deferred.await(next.gate)
						return Stream.fromIterable(next.parts)
					}),
				),
		})
		return customModel({ activeModel, make })
	})

const openSession = (root: FoldModel, child: FoldModel) =>
	Session.open({
		agent: defineAgent({
			model: root,
			tools: [subagentTool([defineSubagent({ name: 'worker', description: 'works', model: child })])],
		}),
	})

const silent = { renderNote: () => Effect.void }

it.effect('waits for background agents and their notification turn, then returns the latest root outcome', () =>
	Effect.gen(function* () {
		const release = yield* Deferred.make<void>()
		const session = yield* openSession(
			yield* scripted([launchInBackground, text('started'), text('final answer with the result')]),
			yield* scripted([text('worker result', release)]),
		)
		const sent = yield* session.send('go')
		expect(sent.resultText).toBe('started')

		const settling = yield* Effect.forkScoped(settleBackgroundWork(session, silent, sent))
		yield* Deferred.succeed(release, undefined)
		const settled = yield* Fiber.join(settling)

		expect(settled.resultText).toBe('final answer with the result')
		expect((yield* session.backgroundTasks).map((task) => task.status)).toEqual(['completed'])
	}).pipe(Effect.scoped),
)

it.effect('stops background agents that outlive the timeout, without another turn', () =>
	Effect.gen(function* () {
		const never = yield* Deferred.make<void>()
		const notes: Array<string> = []
		const session = yield* openSession(
			yield* scripted([launchInBackground, text('started')]),
			yield* scripted([text('never', never)]),
		)
		const sent = yield* session.send('go')

		const settling = yield* Effect.forkScoped(
			settleBackgroundWork(
				session,
				{ renderNote: (note) => Effect.sync(() => notes.push(note)) },
				sent,
				Duration.minutes(1),
			),
		)
		yield* TestClock.adjust(Duration.minutes(1))
		const settled = yield* Fiber.join(settling)

		expect(settled.resultText).toBe('started')
		expect((yield* session.backgroundTasks).map((task) => task.status)).toEqual(['stopped'])
		expect(notes[0]).toBe('waiting for 1 background agent to finish')
		expect(notes[1]).toContain('stopping them')
	}).pipe(Effect.scoped),
)
