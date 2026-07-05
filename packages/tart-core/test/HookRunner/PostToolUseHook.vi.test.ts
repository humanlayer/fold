import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { AgentId, HookRunner, ToolCallId, type PostToolUseHook } from '../../src'
import { runWithHookRunner } from '../TestLayers/HookRunnerTestHarness'

describe('HookRunner postToolUse hooks', () => {
	it.effect('runs hooks in order and passes replaced result to the next hook', () =>
		Effect.gen(function* () {
			const calls: Array<unknown> = []
			const hooks: ReadonlyArray<PostToolUseHook> = [
				{
					name: 'first',
					handler: ({ result, isFailure }) => {
						calls.push({ result, isFailure })
						return Effect.succeed({ _tag: 'replace' as const, result: { step: 1 }, isFailure: true })
					},
				},
				{
					name: 'second',
					handler: ({ result, isFailure }) => {
						calls.push({ result, isFailure })
						return Effect.succeed({ _tag: 'replace' as const, result: { step: 2 }, isFailure: false })
					},
				},
			]

			const result = yield* runWithHookRunner(
				{ postToolUse: hooks },
				Effect.gen(function* () {
					const hookRunner = yield* HookRunner
					return yield* hookRunner.postToolUse({
						agentId: AgentId.create(),
						parentAgentId: null,
						toolCallId: ToolCallId.create(),
						toolName: 'echo',
						result: { step: 0 },
						isFailure: false,
					})
				}),
			)

			expect(calls).toEqual([
				{ result: { step: 0 }, isFailure: false },
				{ result: { step: 1 }, isFailure: true },
			])
			expect(result).toEqual({ _tag: 'replace', result: { step: 2 }, isFailure: false })
		}),
	)

	it.effect('keeps the accumulated result when a later hook returns keep', () =>
		Effect.gen(function* () {
			const hooks: ReadonlyArray<PostToolUseHook> = [
				{
					name: 'replace',
					handler: () =>
						Effect.succeed({ _tag: 'replace' as const, result: { replaced: true }, isFailure: true }),
				},
				{
					name: 'keep',
					handler: () => Effect.succeed({ _tag: 'keep' as const }),
				},
			]

			const result = yield* runWithHookRunner(
				{ postToolUse: hooks },
				Effect.gen(function* () {
					const hookRunner = yield* HookRunner
					return yield* hookRunner.postToolUse({
						agentId: AgentId.create(),
						parentAgentId: null,
						toolCallId: ToolCallId.create(),
						toolName: 'echo',
						result: { original: true },
						isFailure: false,
					})
				}),
			)

			expect(result).toEqual({ _tag: 'replace', result: { replaced: true }, isFailure: true })
		}),
	)

	it.effect('runs only hooks matching the tool filter', () =>
		Effect.gen(function* () {
			const calls: Array<string> = []
			const hooks: ReadonlyArray<PostToolUseHook> = [
				{
					name: 'skipped',
					tools: ['read'],
					handler: () => {
						calls.push('skipped')
						return Effect.succeed({ _tag: 'replace' as const, result: { skipped: true }, isFailure: true })
					},
				},
				{
					name: 'matched',
					tools: ['echo'],
					handler: () => {
						calls.push('matched')
						return Effect.succeed({ _tag: 'replace' as const, result: { matched: true }, isFailure: false })
					},
				},
			]

			const result = yield* runWithHookRunner(
				{ postToolUse: hooks },
				Effect.gen(function* () {
					const hookRunner = yield* HookRunner
					return yield* hookRunner.postToolUse({
						agentId: AgentId.create(),
						parentAgentId: null,
						toolCallId: ToolCallId.create(),
						toolName: 'echo',
						result: { original: true },
						isFailure: false,
					})
				}),
			)

			expect(calls).toEqual(['matched'])
			expect(result).toEqual({ _tag: 'replace', result: { matched: true }, isFailure: false })
		}),
	)
})
