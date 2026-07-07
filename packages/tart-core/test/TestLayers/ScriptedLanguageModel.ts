/**
 * This file provides a scripted LanguageModel test layer - a real `LanguageModel.make` provider whose
 * responses come from a fixed script of turns instead of a network call. Each streamText request
 * consumes the next turn and records the request it was sent - the prompt, the advertised tool names,
 * and the OpenAI per-request Config present in context (read exactly where the real provider reads it) -
 * so tests can assert exactly what the runtime asked the model and replay multi-turn conversations
 * deterministically.
 *
 * Turn helpers build provider-shaped encoded stream parts: `toolCallTurn` emits provider-style ids
 * (for example `provider-call-1`) so tests can prove tart's tool-call id rewriting.
 */
import { AnthropicLanguageModel } from '@effect/ai-anthropic'
import { OpenAiLanguageModel } from '@effect/ai-openai'
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

/** Build the encoded `finish` stream part for a scripted turn, so raw turns can reuse the standard shape. */
export const finishPart = (options?: ScriptedFinishOptions): Response.StreamPartEncoded => ({
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

/** One recorded model request: what the runtime sent and the request context it sent it under. */
export type ScriptedRequest = {
	readonly prompt: Prompt.Prompt
	/** Tool names advertised to the model on this request. */
	readonly toolNames: ReadonlyArray<string>
	/** The OpenAI per-request Config in context at request time, or null when none was provided. */
	readonly openAiConfig: typeof OpenAiLanguageModel.Config.Service | null
	/** The Anthropic per-request Config in context at request time, or null when none was provided. */
	readonly anthropicConfig: typeof AnthropicLanguageModel.Config.Service | null
}

/** Handle to a scripted model: the layer under test plus the requests the runtime actually sent. */
export type ScriptedLanguageModel = {
	readonly layer: Layer.Layer<LanguageModel.LanguageModel>
	/** Every prompt the runtime sent, in request order. */
	readonly prompts: Effect.Effect<ReadonlyArray<Prompt.Prompt>>
	/** Every request the runtime sent (prompt, tool names, request config), in request order. */
	readonly requests: Effect.Effect<ReadonlyArray<ScriptedRequest>>
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
export const makeScriptedLanguageModel = (turns: ReadonlyArray<ScriptedTurn>): Effect.Effect<ScriptedLanguageModel> =>
	Effect.gen(function* () {
		const turnsRef = yield* Ref.make<ReadonlyArray<ScriptedTurn>>(turns)
		const requestsRef = yield* Ref.make<ReadonlyArray<ScriptedRequest>>([])

		const nextTurn = (options: LanguageModel.ProviderOptions): Effect.Effect<ScriptedTurn> =>
			Effect.gen(function* () {
				// Read the per-request provider Configs from the ambient context - the same services the real
				// providers merge when they build a request - so tests observe exactly what a provider would.
				const openAiConfig = yield* Effect.serviceOption(OpenAiLanguageModel.Config)
				const anthropicConfig = yield* Effect.serviceOption(AnthropicLanguageModel.Config)

				yield* Ref.update(requestsRef, (requests) => [
					...requests,
					{
						prompt: options.prompt,
						toolNames: options.tools.map((tool) => tool.name),
						openAiConfig: openAiConfig._tag === 'Some' ? openAiConfig.value : null,
						anthropicConfig: anthropicConfig._tag === 'Some' ? anthropicConfig.value : null,
					},
				])

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
				Effect.die(
					new Error('ScriptedLanguageModel supports streamText only - the agent loop uses streamText'),
				),
			streamText: (options) =>
				Stream.unwrap(
					nextTurn(options).pipe(
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
			prompts: Ref.get(requestsRef).pipe(Effect.map((requests) => requests.map((request) => request.prompt))),
			requests: Ref.get(requestsRef),
			remainingTurns: Ref.get(turnsRef).pipe(Effect.map((remaining) => remaining.length)),
		}
	})
