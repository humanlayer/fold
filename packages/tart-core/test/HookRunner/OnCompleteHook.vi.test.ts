import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { AgentId, HookRunner, makeHookRunner, type OnCompleteHook } from '../../src'

describe('HookRunner onComplete hooks', () => {
	it.effect('runs complete hooks in order', () =>
		Effect.gen(function* () {
			const calls: Array<string> = []
			const hooks: ReadonlyArray<OnCompleteHook> = [
				{
					name: 'first',
					handler: () => {
						calls.push('first')
						return Effect.succeed({ _tag: 'complete' as const })
					},
				},
				{
					name: 'second',
					handler: () => {
						calls.push('second')
						return Effect.succeed({ _tag: 'complete' as const })
					},
				},
			]

			const result = yield* Effect.gen(function* () {
				const hookRunner = yield* HookRunner
				return yield* hookRunner.onComplete({ agentId: AgentId.create(), resultText: 'done' })
			}).pipe(Effect.provide(makeHookRunner({ onComplete: hooks })))

			expect(calls).toEqual(['first', 'second'])
			expect(result).toEqual({ _tag: 'complete' })
		}),
	)

	it.effect('returns continueWith and short-circuits later hooks', () =>
		Effect.gen(function* () {
			const calls: Array<string> = []
			const hooks: ReadonlyArray<OnCompleteHook> = [
				{
					name: 'continue',
					handler: () => {
						calls.push('continue')
						return Effect.succeed({ _tag: 'continueWith' as const, text: 'keep going' })
					},
				},
				{
					name: 'never',
					handler: () => {
						calls.push('never')
						return Effect.succeed({ _tag: 'complete' as const })
					},
				},
			]

			const result = yield* Effect.gen(function* () {
				const hookRunner = yield* HookRunner
				return yield* hookRunner.onComplete({ agentId: AgentId.create(), resultText: 'done' })
			}).pipe(Effect.provide(makeHookRunner({ onComplete: hooks })))

			expect(calls).toEqual(['continue'])
			expect(result).toEqual({ _tag: 'continueWith', text: 'keep going' })
		}),
	)
})
