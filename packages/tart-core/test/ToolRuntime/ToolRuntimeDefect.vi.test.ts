import { expect, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'

import { makeHookRunner, messagesForAgent, StopController, ToolRuntime } from '../../src/index'
import { layerEchoTool, makeEchoRecorder, TestToolkit } from '../TestLayers/TestTools'
import { agentId, collectEntries, makeAssistantToolCall, toolRuntimeBaseLayer } from './ToolRuntimeTestHelpers'

const projectedToolResultPart = (projected: ReturnType<typeof messagesForAgent>) => {
	const toolResult = projected.find((message) => message._tag === 'tool-result')

	expect(toolResult?._tag).toBe('tool-result')
	if (toolResult?._tag !== 'tool-result') throw new Error('Expected a projected tool-result')

	const part = toolResult.message.content[0]
	if (part === undefined || part.type !== 'tool-result') throw new Error('Expected a tool-result content part')

	return part
}

it.effect('projects tool handler defects as model-visible tool failures', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const toolLayer = TestToolkit.toLayer(
			TestToolkit.of({
				echo: ({ text }) =>
					Effect.gen(function* () {
						yield* Ref.update(recorder.calls, (calls) => [...calls, text])
						return yield* Effect.die(new Error('boom'))
					}),
			}),
		)
		const layer = toolRuntimeBaseLayer(makeHookRunner({}), toolLayer)

		const result = yield* Effect.gen(function* () {
			const runtime = yield* ToolRuntime
			const settlement = yield* runtime.settle({
				agentId,
				parentAgentId: null,
				assistantMessage: makeAssistantToolCall({ text: 'hi' }),
			})
			const entries = yield* collectEntries
			const calls = yield* Ref.get(recorder.calls)

			return { settlement, projected: messagesForAgent(entries, agentId), calls }
		}).pipe(Effect.provide(layer))

		expect(result.calls).toEqual(['hi'])
		expect(result.settlement.toolResults).toHaveLength(1)
		expect(projectedToolResultPart(result.projected)).toMatchObject({
			type: 'tool-result',
			name: 'echo',
			isFailure: true,
			result: '<system-information>Tool "echo" failed unexpectedly: boom</system-information>',
		})
	}),
)

it.effect('truncates long defect messages before projecting them to the model', () =>
	Effect.gen(function* () {
		const longMessage = `prefix ${'x'.repeat(500)} suffix`
		const toolLayer = TestToolkit.toLayer(
			TestToolkit.of({
				echo: () => Effect.die(new Error(longMessage)),
			}),
		)
		const layer = toolRuntimeBaseLayer(makeHookRunner({}), toolLayer)

		const projected = yield* Effect.gen(function* () {
			const runtime = yield* ToolRuntime
			yield* runtime.settle({
				agentId,
				parentAgentId: null,
				assistantMessage: makeAssistantToolCall({ text: 'hi' }),
			})
			const entries = yield* collectEntries

			return messagesForAgent(entries, agentId)
		}).pipe(Effect.provide(layer))

		const result = projectedToolResultPart(projected).result

		expect(typeof result).toBe('string')
		if (typeof result !== 'string') return
		expect(result).toContain('<system-information>Tool "echo" failed unexpectedly: prefix ')
		expect(result).toContain('...</system-information>')
		expect(result).not.toContain('suffix')
		expect(result.length).toBeLessThan(380)
	}),
)

it.effect('projects tool defects after cooperative stop requests as model-visible tool failures', () =>
	Effect.gen(function* () {
		const toolLayer = TestToolkit.toLayer(
			TestToolkit.of({
				echo: () =>
					Effect.gen(function* () {
						const stop = yield* StopController
						yield* stop.requestStop('tool asked to stop before crashing')
						return yield* Effect.die(new Error('tool crashed after stop'))
					}),
			}),
		)
		const layer = toolRuntimeBaseLayer(makeHookRunner({}), toolLayer)

		const result = yield* Effect.gen(function* () {
			const runtime = yield* ToolRuntime
			const settlement = yield* runtime.settle({
				agentId,
				parentAgentId: null,
				assistantMessage: makeAssistantToolCall({ text: 'hi' }),
			})
			const entries = yield* collectEntries

			return { settlement, projected: messagesForAgent(entries, agentId) }
		}).pipe(Effect.provide(layer))

		expect(result.settlement.stopRequested).toBe(true)
		expect(projectedToolResultPart(result.projected)).toMatchObject({
			type: 'tool-result',
			name: 'echo',
			isFailure: true,
			result: '<system-information>Tool "echo" failed unexpectedly: tool crashed after stop</system-information>',
		})
	}),
)

it.effect('projects preToolUse hook defects as model-visible tool failures and skips the handler', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const hookLayer = makeHookRunner({
			preToolUse: [
				{
					name: 'guard',
					tools: ['echo'],
					handler: () => Effect.die(new Error('policy service crashed')),
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
			const entries = yield* collectEntries
			const calls = yield* Ref.get(recorder.calls)

			return { settlement, projected: messagesForAgent(entries, agentId), calls }
		}).pipe(Effect.provide(layer))

		expect(result.calls).toEqual([])
		expect(result.settlement.toolResults).toHaveLength(1)
		expect(projectedToolResultPart(result.projected)).toMatchObject({
			type: 'tool-result',
			name: 'echo',
			isFailure: true,
			result: '<system-information>preToolUse hook "guard" failed unexpectedly while preparing tool "echo": policy service crashed</system-information>',
		})
	}),
)

it.effect('projects postToolUse hook defects as model-visible tool failures', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const hookLayer = makeHookRunner({
			postToolUse: [
				{
					name: 'redactor',
					tools: ['echo'],
					handler: () => Effect.die(new Error('redaction crashed')),
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
			const entries = yield* collectEntries
			const calls = yield* Ref.get(recorder.calls)

			return { settlement, projected: messagesForAgent(entries, agentId), calls }
		}).pipe(Effect.provide(layer))

		expect(result.calls).toEqual(['hi'])
		expect(result.settlement.toolResults).toHaveLength(1)
		expect(projectedToolResultPart(result.projected)).toMatchObject({
			type: 'tool-result',
			name: 'echo',
			isFailure: true,
			result: '<system-information>postToolUse hook "redactor" failed unexpectedly while finalizing tool "echo": redaction crashed</system-information>',
		})
	}),
)

it.effect('projects hook defects after StopController requests as hook failures', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const hookLayer = makeHookRunner({
			preToolUse: [
				{
					name: 'stopper',
					tools: ['echo'],
					handler: () =>
						Effect.gen(function* () {
							const stop = yield* StopController
							yield* stop.requestStop('before crash')
							return yield* Effect.die(new Error('stop hook crashed'))
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
			const entries = yield* collectEntries

			return { settlement, projected: messagesForAgent(entries, agentId) }
		}).pipe(Effect.provide(layer))

		expect(result.settlement.stopRequested).toBe(true)
		expect(projectedToolResultPart(result.projected)).toMatchObject({
			type: 'tool-result',
			name: 'echo',
			isFailure: true,
			result: '<system-information>preToolUse hook "stopper" failed unexpectedly while preparing tool "echo": stop hook crashed</system-information>',
		})
	}),
)
