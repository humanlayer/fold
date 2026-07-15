import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import { defineToolState, makeHookRunner, toolStateForAgent, ToolRuntime } from '../../src/index'
import { layerStatefulEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import {
	agentId,
	collectEntries,
	makeAssistantToolCall,
	toolCallId,
	toolRuntimeBaseLayer,
} from './ToolRuntimeTestHelpers'

const AuditState = defineToolState({
	namespace: 'audit',
	keys: {
		seen: Schema.Number,
	},
})

it.effect('a preToolUse hook writes durable state in its declared namespace, separate from the tool namespace', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		// The hook name differs from its declared ToolState namespace ('audit'), proving the persisted
		// namespace comes from the AuditState definition rather than the hook's name.
		const hookLayer = makeHookRunner({
			preToolUse: [
				{
					name: 'audit-hook',
					tools: ['echo'],
					handler: ({ params }) =>
						Effect.gen(function* () {
							const seen = (yield* AuditState.get('seen')) ?? 0
							yield* AuditState.set('seen', seen + 1)

							return { _tag: 'continue' as const, params }
						}),
				},
			],
		})
		const layer = toolRuntimeBaseLayer(hookLayer, layerStatefulEchoTool(recorder))

		const result = yield* Effect.gen(function* () {
			const runtime = yield* ToolRuntime

			const settlement = yield* runtime.settle({
				agentId,
				parentAgentId: null,
				assistantMessage: makeAssistantToolCall({ text: 'state-value' }),
			})

			const entries = yield* collectEntries

			return {
				settlement,
				entries,
				hookState: toolStateForAgent(entries, agentId, 'audit'),
				toolState: toolStateForAgent(entries, agentId, 'echo'),
			}
		}).pipe(Effect.provide(layer))

		const stateEntries = result.entries.filter((entry) => entry._tag === 'tool_state')
		expect(stateEntries.map((entry) => entry.namespace).sort()).toEqual(['audit', 'echo'])

		const auditEntry = stateEntries.find((entry) => entry.namespace === 'audit')
		expect(auditEntry).toMatchObject({
			agentId,
			toolCallId,
			key: 'seen',
			value: 1,
		})

		expect(result.hookState).toEqual({ seen: 1 })
		expect(result.toolState).toEqual({ last: 'state-value' })
		expect(result.settlement.toolResults).toHaveLength(1)
	}),
)
