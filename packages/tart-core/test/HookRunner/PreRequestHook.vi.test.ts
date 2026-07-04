import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import { AgentId, HookRunner, makeHookRunner, type PreRequestHook } from '../../src'

const makePrompt = (text: string) =>
	Prompt.fromMessages([
		Prompt.userMessage({
			content: [Prompt.textPart({ text })],
		}),
	])

describe('HookRunner preRequest hooks', () => {
	it.effect('runs hooks in order and passes changed prompt to the next hook', () =>
		Effect.gen(function* () {
			const originalPrompt = makePrompt('original')
			const firstPrompt = makePrompt('first')
			const secondPrompt = makePrompt('second')
			const calls: Array<unknown> = []
			const hooks: ReadonlyArray<PreRequestHook> = [
				{
					name: 'first',
					handler: ({ prompt }) => {
						calls.push(prompt)
						return Effect.succeed({ _tag: 'changed' as const, prompt: firstPrompt })
					},
				},
				{
					name: 'second',
					handler: ({ prompt }) => {
						calls.push(prompt)
						return Effect.succeed({ _tag: 'changed' as const, prompt: secondPrompt })
					},
				},
			]

			const result = yield* Effect.gen(function* () {
				const hookRunner = yield* HookRunner
				return yield* hookRunner.preRequest({ agentId: AgentId.create(), prompt: originalPrompt })
			}).pipe(Effect.provide(makeHookRunner({ preRequest: hooks })))

			expect(calls).toEqual([originalPrompt, firstPrompt])
			expect(result).toEqual({ _tag: 'changed', prompt: secondPrompt })
		}),
	)

	it.effect('returns changed when an earlier hook changes the prompt and a later hook leaves it unchanged', () =>
		Effect.gen(function* () {
			const changedPrompt = makePrompt('changed')
			const hooks: ReadonlyArray<PreRequestHook> = [
				{
					name: 'change',
					handler: () => Effect.succeed({ _tag: 'changed' as const, prompt: changedPrompt }),
				},
				{
					name: 'unchanged',
					handler: () => Effect.succeed({ _tag: 'unchanged' as const }),
				},
			]

			const result = yield* Effect.gen(function* () {
				const hookRunner = yield* HookRunner
				return yield* hookRunner.preRequest({ agentId: AgentId.create(), prompt: makePrompt('original') })
			}).pipe(Effect.provide(makeHookRunner({ preRequest: hooks })))

			expect(result).toEqual({ _tag: 'changed', prompt: changedPrompt })
		}),
	)
})
