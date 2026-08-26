import { expect, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'

import { makeHookRunner, messagesForAgent, ToolRuntime } from '../../src/index'
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { agentId, collectEntries, makeAssistantToolCall, toolRuntimeBaseLayer } from './ToolRuntimeTestHelpers'

it.effect('live preToolUse hook can replace the result and skip the handler', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const hookLayer = makeHookRunner({
			preToolUse: [
				{
					name: 'block-echo',
					tools: ['echo'],
					handler: () =>
						Effect.succeed({
							_tag: 'replaceResult' as const,
							result: { blocked: true },
							isFailure: true,
						}),
				},
			],
		})
		const layer = toolRuntimeBaseLayer(hookLayer, layerEchoTool(recorder))

		const result = yield* Effect.gen(function* () {
			const runtime = yield* ToolRuntime

			const settlement = yield* runtime.settle({
				agentId,
				parentAgentId: null,
				assistantMessage: makeAssistantToolCall({ text: 'hi' }),
			})

			const calls = yield* Ref.get(recorder.calls)

			return { settlement, calls }
		}).pipe(Effect.provide(layer))

		expect(result.calls).toEqual([])

		const toolResult = result.settlement.toolResults[0]
		expect(toolResult?.message.content[0]).toMatchObject({
			type: 'tool-result',
			id: 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa',
			name: 'echo',
			isFailure: true,
			result: { blocked: true },
		})
	}),
)

it.effect('live preToolUse hook can update execution params without changing prompt projection', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const hookLayer = makeHookRunner({
			preToolUse: [
				{
					name: 'mutate-echo',
					tools: ['echo'],
					handler: () =>
						Effect.succeed({
							_tag: 'continue' as const,
							params: { text: 'mutated' },
						}),
				},
			],
		})
		const layer = toolRuntimeBaseLayer(hookLayer, layerEchoTool(recorder))
		const assistantMessage = makeAssistantToolCall({ text: 'original' })

		const result = yield* Effect.gen(function* () {
			const runtime = yield* ToolRuntime

			const settlement = yield* runtime.settle({
				agentId,
				parentAgentId: null,
				assistantMessage,
			})

			const entries = yield* collectEntries
			const calls = yield* Ref.get(recorder.calls)

			return {
				settlement,
				entries,
				projected: messagesForAgent(entries, agentId),
				calls,
			}
		}).pipe(Effect.provide(layer))

		expect(result.calls).toEqual(['mutated'])

		const toolResult = result.settlement.toolResults[0]
		expect(toolResult?.executedInput).toEqual({ text: 'mutated' })
		expect(assistantMessage.content[0]).toMatchObject({
			type: 'tool-call',
			params: { text: 'original' },
		})

		const projectedToolResult = result.projected.find((message) => message._tag === 'tool-result')
		expect(projectedToolResult).not.toHaveProperty('executedInput')
	}),
)

it.effect('postToolUse receives original, executed, and handler values while hooks compose in order', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const observed = yield* Ref.make<ReadonlyArray<unknown>>([])
		const hookLayer = makeHookRunner({
			preToolUse: [
				{
					name: 'mutate-echo',
					tools: ['echo'],
					handler: () => Effect.succeed({ _tag: 'continue' as const, params: { text: 'executed' } }),
				},
			],
			postToolUse: [
				{
					name: 'decorate-echo',
					tools: ['echo'],
					handler: (input) =>
						Ref.update(observed, (values) => [...values, input]).pipe(
							Effect.as({ _tag: 'replace' as const, result: { decorated: true }, isFailure: false }),
						),
				},
				{
					name: 'observe-decorated-echo',
					tools: ['echo'],
					handler: (input) =>
						Ref.update(observed, (values) => [...values, input]).pipe(Effect.as({ _tag: 'keep' as const })),
				},
			],
		})
		const layer = toolRuntimeBaseLayer(hookLayer, layerEchoTool(recorder))

		const settlement = yield* Effect.gen(function* () {
			const runtime = yield* ToolRuntime
			return yield* runtime.settle({
				agentId,
				parentAgentId: null,
				assistantMessage: makeAssistantToolCall({ text: 'original' }),
			})
		}).pipe(Effect.provide(layer))

		const calls = yield* Ref.get(observed)
		expect(calls).toHaveLength(2)
		expect(calls[0]).toMatchObject({
			originalInput: { text: 'original' },
			executedInput: { text: 'executed' },
			handlerResult: { echoed: 'executed' },
			result: { echoed: 'executed' },
		})
		expect(calls[1]).toMatchObject({
			originalInput: { text: 'original' },
			executedInput: { text: 'executed' },
			handlerResult: { echoed: 'executed' },
			result: { decorated: true },
		})
		expect(settlement.toolResults[0]?.executedInput).toEqual({ text: 'executed' })
		expect(settlement.toolResults[0]?.message.content[0]).toMatchObject({ result: { decorated: true } })
	}),
)
