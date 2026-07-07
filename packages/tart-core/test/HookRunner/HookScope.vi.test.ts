import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Ref, Schema } from 'effect'

import {
	AgentId,
	defineToolState,
	HookRunner,
	layerInMemoryEventLog,
	makeHookRunner,
	StopController,
	ToolCallId,
	type HookConfig,
} from '../../src/index'
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime'
import { makeRecordingStopController, noopStopController } from '../TestLayers/TestStopController'
import { collectEntries } from '../ToolRuntime/ToolRuntimeTestHelpers'

const agentId = AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
const toolCallId = ToolCallId.make('tool_call_aaaaaaaaaaaaaaaaaaaaaaaa')

const GuardState = defineToolState({
	namespace: 'guard',
	keys: {
		count: Schema.Number,
	},
})

/** Build one layer tree where the HookRunner and the assertions share the same memory EventLog. */
const hookScopeLayer = (config: HookConfig) => {
	const infra = Layer.mergeAll(
		layerInMemoryEventLog,
		layerDeterministicRuntime({ startMillis: 1_000, stepMillis: 0 }),
	)

	return Layer.mergeAll(makeHookRunner(config).pipe(Layer.provide(infra)), infra)
}

describe('HookRunner hook scope services', () => {
	it.effect('a preToolUse hook reads and writes durable state in its own namespace', () =>
		Effect.gen(function* () {
			const config: HookConfig = {
				preToolUse: [
					{
						// Hook name deliberately differs from GuardState's declared namespace ('guard'):
						// the persisted namespace must come from the definition, not the hook's name.
						name: 'guard-hook',
						handler: ({ params }) =>
							Effect.gen(function* () {
								const count = (yield* GuardState.get('count')) ?? 0
								yield* GuardState.set('count', count + 1)

								return { _tag: 'continue' as const, params }
							}),
					},
				],
			}

			const result = yield* Effect.gen(function* () {
				const hookRunner = yield* HookRunner

				const first = yield* hookRunner.preToolUse({
					agentId,
					parentAgentId: null,
					toolCallId,
					toolName: 'echo',
					params: { text: 'one' },
				})

				const second = yield* hookRunner.preToolUse({
					agentId,
					parentAgentId: null,
					toolCallId,
					toolName: 'echo',
					params: { text: 'two' },
				})

				const entries = yield* collectEntries

				return { first, second, entries }
			}).pipe(Effect.provideService(StopController, noopStopController), Effect.provide(hookScopeLayer(config)))

			expect(result.first).toEqual({ _tag: 'continue', params: { text: 'one' } })
			expect(result.second).toEqual({ _tag: 'continue', params: { text: 'two' } })

			const stateEntries = result.entries.filter((entry) => entry._tag === 'tool_state')
			expect(stateEntries).toHaveLength(2)
			expect(stateEntries[0]).toMatchObject({
				namespace: 'guard',
				toolCallId,
				agentId,
				key: 'count',
				value: 1,
			})
			expect(stateEntries[1]).toMatchObject({ namespace: 'guard', key: 'count', value: 2 })
		}),
	)

	it.effect('an onComplete hook writes durable state with a null toolCallId', () =>
		Effect.gen(function* () {
			const JudgeState = defineToolState({
				namespace: 'judge',
				keys: {
					attempts: Schema.Number,
				},
			})

			const config: HookConfig = {
				onComplete: [
					{
						// Hook name differs from JudgeState's declared namespace ('judge').
						name: 'judge-hook',
						handler: () =>
							Effect.gen(function* () {
								const attempts = (yield* JudgeState.get('attempts')) ?? 0
								yield* JudgeState.set('attempts', attempts + 1)

								return { _tag: 'complete' as const }
							}),
					},
				],
			}

			const result = yield* Effect.gen(function* () {
				const hookRunner = yield* HookRunner

				const decision = yield* hookRunner.onComplete({
					agentId,
					parentAgentId: null,
					resultText: 'done',
				})

				const entries = yield* collectEntries

				return { decision, entries }
			}).pipe(Effect.provideService(StopController, noopStopController), Effect.provide(hookScopeLayer(config)))

			expect(result.decision).toEqual({ _tag: 'complete' })

			const stateEntries = result.entries.filter((entry) => entry._tag === 'tool_state')
			expect(stateEntries).toHaveLength(1)
			expect(stateEntries[0]).toMatchObject({
				namespace: 'judge',
				toolCallId: null,
				agentId,
				key: 'attempts',
				value: 1,
			})
		}),
	)

	it.effect('a hook can request a cooperative stop and still return a normal decision', () =>
		Effect.gen(function* () {
			const config: HookConfig = {
				preToolUse: [
					{
						name: 'stopper',
						handler: ({ params }) =>
							Effect.gen(function* () {
								const stop = yield* StopController
								yield* stop.requestStop('budget exhausted')

								return { _tag: 'continue' as const, params }
							}),
					},
				],
			}

			const stop = yield* makeRecordingStopController

			const decision = yield* Effect.gen(function* () {
				const hookRunner = yield* HookRunner

				return yield* hookRunner.preToolUse({
					agentId,
					parentAgentId: null,
					toolCallId,
					toolName: 'echo',
					params: { text: 'hi' },
				})
			}).pipe(Effect.provideService(StopController, stop.service), Effect.provide(hookScopeLayer(config)))

			const requests = yield* Ref.get(stop.requests)

			expect(decision).toEqual({ _tag: 'continue', params: { text: 'hi' } })
			expect(requests).toEqual(['budget exhausted'])
		}),
	)
})
