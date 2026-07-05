import { expect, it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'

import {
	AgentId,
	defineToolState,
	EventLog,
	HookRunner,
	layerMemory,
	makeHookRunner,
	StateId,
	StopController,
	ToolCallId,
	type HookConfig,
} from '../../src/index'
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime'
import { noopStopController } from '../TestLayers/TestStopController'
import { collectEntries } from '../ToolRuntime/ToolRuntimeTestHelpers'

const agentId = AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
const toolCallId = ToolCallId.make('tool_call_aaaaaaaaaaaaaaaaaaaaaaaa')

const GuardState = defineToolState({
	namespace: 'guard',
	keys: {
		count: Schema.Number,
	},
})

it.effect('a hook reproduces its state from tool_state entries already persisted in the log', () =>
	Effect.gen(function* () {
		const config: HookConfig = {
			preToolUse: [
				{
					name: 'guard-hook',
					handler: () =>
						Effect.gen(function* () {
							const count = (yield* GuardState.get('count')) ?? 0
							yield* GuardState.set('count', count + 1)

							return { _tag: 'continue' as const, params: { count: count + 1 } }
						}),
				},
			],
		}

		const infra = Layer.mergeAll(layerMemory, layerDeterministicRuntime({ startMillis: 1_000, stepMillis: 0 }))
		const layer = Layer.mergeAll(makeHookRunner(config).pipe(Layer.provide(infra)), infra)

		const result = yield* Effect.gen(function* () {
			// Seed the log directly, as if a previous process had persisted hook state before shutdown.
			const eventLog = yield* EventLog
			yield* eventLog.append({
				_tag: 'tool_state',
				agentId,
				parentAgentId: null,
				toolCallId: null,
				namespace: 'guard',
				stateId: StateId.make('state_aaaaaaaaaaaaaaaaaaaaaaaa'),
				key: 'count',
				value: 41,
			})

			const hookRunner = yield* HookRunner
			const decision = yield* hookRunner.preToolUse({
				agentId,
				parentAgentId: null,
				toolCallId,
				toolName: 'echo',
				params: {},
			})

			const entries = yield* collectEntries

			return { decision, entries }
		}).pipe(Effect.provideService(StopController, noopStopController), Effect.provide(layer))

		expect(result.decision).toEqual({ _tag: 'continue', params: { count: 42 } })

		const stateEntries = result.entries.filter((entry) => entry._tag === 'tool_state')
		expect(stateEntries.map((entry) => entry.value)).toEqual([41, 42])
		expect(stateEntries[1]).toMatchObject({ namespace: 'guard', key: 'count', toolCallId })
	}),
)
