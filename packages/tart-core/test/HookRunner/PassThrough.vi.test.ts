import { expect, it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import {
	AgentId,
	HookRunner,
	OnCompleteHookDecision,
	PostToolUseHookDecision,
	PreRequestHookDecision,
	PreToolUseHookDecision,
	ToolCallId,
} from '../../src/index'
import { hookRunnerNoop } from '../TestLayers/NoOpHookRunner'
import { layerNoopStopController } from '../TestLayers/TestStopController'

const makePrompt = () =>
	Prompt.fromMessages([
		Prompt.userMessage({
			content: [Prompt.textPart({ text: 'hello' })],
		}),
	])

it.effect('layerNoHooks returns pass-through decisions', () =>
	Effect.gen(function* () {
		const hooks = yield* HookRunner
		const agentId = AgentId.create()
		const toolCallId = ToolCallId.create()
		const prompt = makePrompt()
		const params = { text: 'hello' }

		const preRequest = yield* hooks.preRequest({
			agentId,
			parentAgentId: null,
			prompt,
		})

		const preToolUse = yield* hooks.preToolUse({
			agentId,
			parentAgentId: null,
			toolCallId,
			toolName: 'echo',
			params,
		})

		const postToolUse = yield* hooks.postToolUse({
			agentId,
			parentAgentId: null,
			toolCallId,
			toolName: 'echo',
			result: { echoed: 'hello' },
			isFailure: false,
		})

		const onComplete = yield* hooks.onComplete({
			agentId,
			parentAgentId: null,
			resultText: 'done',
		})

		expect(preRequest).toEqual({ _tag: 'unchanged' })
		expect(preToolUse).toEqual({ _tag: 'continue', params })
		expect(postToolUse).toEqual({ _tag: 'keep' })
		expect(onComplete).toEqual({ _tag: 'complete' })
	}).pipe(Effect.provide(Layer.mergeAll(hookRunnerNoop, layerNoopStopController))),
)

it.effect('defines schema-derived hook decision types', () =>
	Effect.gen(function* () {
		const preRequest = yield* Schema.decodeUnknownEffect(PreRequestHookDecision)({
			_tag: 'unchanged',
		})

		const preToolUse = yield* Schema.decodeUnknownEffect(PreToolUseHookDecision)({
			_tag: 'replaceResult',
			result: { blocked: true },
			isFailure: true,
		})

		const postToolUse = yield* Schema.decodeUnknownEffect(PostToolUseHookDecision)({
			_tag: 'replace',
			result: { rewritten: true },
			isFailure: false,
		})

		const onComplete = yield* Schema.decodeUnknownEffect(OnCompleteHookDecision)({
			_tag: 'continueWith',
			text: 'keep going',
		})

		expect(preRequest).toEqual({ _tag: 'unchanged' })
		expect(preToolUse).toEqual({
			_tag: 'replaceResult',
			result: { blocked: true },
			isFailure: true,
		})
		expect(postToolUse).toEqual({
			_tag: 'replace',
			result: { rewritten: true },
			isFailure: false,
		})
		expect(onComplete).toEqual({
			_tag: 'continueWith',
			text: 'keep going',
		})
	}),
)
