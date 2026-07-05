/**
 * This file provides a scripted LanguageModel test layer - a real `LanguageModel.make` provider whose
 * responses come from a fixed script of turns instead of a network call. Each streamText request
 * consumes the next turn and records the prompt it was sent, so tests can assert exactly what the
 * runtime asked the model and replay multi-turn conversations deterministically.
 *
 * Turn helpers build provider-shaped encoded stream parts: `toolCallTurn` emits provider-style ids
 * (for example `provider-call-1`) so tests can prove tart's tool-call id rewriting.
 */
import { Effect, Layer, Ref, Stream } from 'effect'
import { AiError, LanguageModel, Response } from 'effect/unstable/ai'
import type { Prompt } from 'effect/unstable/ai'

/** Optional shaping for a scripted turn's finish part. */
export type ScriptedFinishOptions = {
	readonly reason?: typeof Response.FinishReason.Type
	readonly inputTokens?: number
	readonly outputTokens?: number
}

/** One scripted model response: either a sequence of stream parts or a provider failure. */
export type ScriptedTurn =
	| { readonly _tag: 'parts'; readonly parts: ReadonlyArray<Response.StreamPartEncoded> }
	| { readonly _tag: 'failure'; readonly message: string }

const finishPart = (options?: ScriptedFinishOptions): Response.StreamPartEncoded => ({
	type: 'finish',
	reason: options?.reason ?? 'stop',
	response: undefined,
	usage: {
		inputTokens: {
			uncached: undefined,
			total: options?.inputTokens ?? 10,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: {
			total: options?.outputTokens ?? 5,
			text: undefined,
			reasoning: undefined,
		},
	},
})

/** A turn where the model streams one text block and finishes. */
export const textTurn = (text: string, options?: ScriptedFinishOptions): ScriptedTurn => ({
	_tag: 'parts',
	parts: [
		{ type: 'text-start', id: 'text-1' },
		{ type: 'text-delta', id: 'text-1', delta: text },
		{ type: 'text-end', id: 'text-1' },
		finishPart(options),
	],
})

/** A turn where the model requests tool calls with provider-shaped ids and finishes. */
export const toolCallTurn = (
	calls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly params: unknown }>,
	options?: ScriptedFinishOptions,
): ScriptedTurn => ({
	_tag: 'parts',
	parts: [
		...calls.map(
			(call): Response.StreamPartEncoded => ({
				type: 'tool-call',
				id: call.id,
				name: call.name,
				params: call.params,
				providerExecuted: false,
			}),
		),
		finishPart({ reason: 'tool-calls', ...options }),
	],
})

/** A turn where the provider fails before producing a response. */
export const failureTurn = (message: string): ScriptedTurn => ({ _tag: 'failure', message })

/** A turn built from raw encoded stream parts, for cases the other helpers do not cover. */
export const rawTurn = (parts: ReadonlyArray<Response.StreamPartEncoded>): ScriptedTurn => ({
	_tag: 'parts',
	parts,
})

/** Handle to a scripted model: the layer under test plus the prompts the runtime actually sent. */
export type ScriptedLanguageModel = {
	readonly layer: Layer.Layer<LanguageModel.LanguageModel>
	/** Every prompt the runtime sent, in request order. */
	readonly prompts: Effect.Effect<ReadonlyArray<Prompt.Prompt>>
	/** Turns not yet consumed; tests can assert the script was fully used. */
	readonly remainingTurns: Effect.Effect<number>
}

const scriptedFailure = (message: string): AiError.AiError =>
	AiError.make({
		module: 'ScriptedLanguageModel',
		method: 'streamText',
		reason: new AiError.UnknownError({ description: message }),
	})

/** Build a scripted LanguageModel from an ordered list of turns. */
export const makeScriptedLanguageModel = (
	turns: ReadonlyArray<ScriptedTurn>,
): Effect.Effect<ScriptedLanguageModel> =>
	Effect.gen(function* () {
		const turnsRef = yield* Ref.make<ReadonlyArray<ScriptedTurn>>(turns)
		const promptsRef = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])

		const nextTurn = (prompt: Prompt.Prompt): Effect.Effect<ScriptedTurn> =>
			Effect.gen(function* () {
				yield* Ref.update(promptsRef, (prompts) => [...prompts, prompt])

				const remaining = yield* Ref.get(turnsRef)
				const turn = remaining[0]
				if (turn === undefined) {
					return yield* Effect.die(new Error('ScriptedLanguageModel: script exhausted - add more turns'))
				}

				yield* Ref.set(turnsRef, remaining.slice(1))
				return turn
			})

		const service = yield* LanguageModel.make({
			generateText: () =>
				Effect.die(new Error('ScriptedLanguageModel supports streamText only - the agent loop uses streamText')),
			streamText: (options) =>
				Stream.unwrap(
					nextTurn(options.prompt).pipe(
						Effect.map((turn) =>
							turn._tag === 'failure'
								? Stream.fail(scriptedFailure(turn.message))
								: Stream.fromIterable(turn.parts),
						),
					),
				),
		})

		return {
			layer: Layer.succeed(LanguageModel.LanguageModel, service),
			prompts: Ref.get(promptsRef),
			remainingTurns: Ref.get(turnsRef).pipe(Effect.map((remaining) => remaining.length)),
		}
	})
