/**
 * LEARNING TEST for the ScriptedLanguageModel test layer.
 *
 * We generally avoid testing test layers. This file exists as executable documentation of how the
 * scripted model works: each `streamText` call consumes the next scripted turn (text, tool calls,
 * or a provider failure) and records the prompt it received, so runtime tests can script whole
 * conversations and assert exactly what the runtime sent to the model. See the AgentRuntime tests
 * for tool-call turns driven through the full loop.
 */
import { expect, it } from '@effect/vitest'
import { Effect, Result, Stream } from 'effect'
import { LanguageModel } from 'effect/unstable/ai'

import { failureTurn, makeScriptedLanguageModel, textTurn } from './ScriptedLanguageModel'

it.effect('consumes turns in order and captures each prompt it was sent', () =>
	Effect.gen(function* () {
		const scripted = yield* makeScriptedLanguageModel([textTurn('Hello!'), failureTurn('rate limited')])

		const run = Effect.gen(function* () {
			const model = yield* LanguageModel.LanguageModel

			const parts = yield* Stream.runCollect(model.streamText({ prompt: 'What is fold?' }))
			const failure = yield* Stream.runCollect(model.streamText({ prompt: 'and again?' })).pipe(Effect.result)

			return { parts, failure }
		})

		const { parts, failure } = yield* run.pipe(Effect.provide(scripted.layer))

		// A text turn streams start/delta/end plus a finish part carrying usage.
		expect(parts.map((part) => part.type)).toEqual(['text-start', 'text-delta', 'text-end', 'finish'])

		// A failure turn fails the stream like a real provider error would.
		expect(Result.isFailure(failure)).toBe(true)

		// Every request's prompt is captured in order for assertions.
		const prompts = yield* scripted.prompts
		expect(prompts).toHaveLength(2)
		expect(JSON.stringify(prompts[0]?.content)).toContain('What is fold?')

		expect(yield* scripted.remainingTurns).toBe(0)
	}),
)
