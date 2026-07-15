/**
 * Harness pieces for the slice-2 session-control tests (D8/D9/D10): a gate tool whose handler parks on
 * a Deferred - so a test can hold a run mid-batch, steer/stop/queue against it deterministically, then
 * release - and a partial-hang scripted model whose first request streams some text deltas and then
 * hangs forever (the interruption target for the partial-assistant-flush assertions), while later
 * requests serve ordinary scripted turns.
 */
import { Deferred, Effect, Ref, Schema, Stream } from 'effect'
import { AiError, LanguageModel } from 'effect/unstable/ai'
import type { Response } from 'effect/unstable/ai'

import { customModel, defineTool, type ActiveModel, type FoldModel, type FoldTool } from '../../src/index'
import type { ScriptedTurn } from '../TestLayers/ScriptedLanguageModel'

/** A tool whose handler parks until released, so tests can act while a batch is in flight. */
export type GateTool = {
	readonly tool: FoldTool
	/** Succeeds when the handler has been entered (the batch is now holding). */
	readonly invoked: Effect.Effect<void>
	/** Lets the parked handler(s) complete. */
	readonly release: Effect.Effect<void>
}

/** Build one gate tool. Each invocation signals `invoked` and then parks until `release`. */
export const makeGateTool = (name: string): Effect.Effect<GateTool> =>
	Effect.gen(function* () {
		const invoked = yield* Deferred.make<void>()
		const gate = yield* Deferred.make<void>()

		const tool = defineTool({
			name,
			description: `Test gate tool ${name}: parks until the test releases it.`,
			parameters: Schema.Struct({}),
			success: Schema.Struct({ content: Schema.String }),
			handler: () =>
				Effect.gen(function* () {
					yield* Deferred.succeed(invoked, undefined)
					yield* Deferred.await(gate)
					return { content: 'released' }
				}),
		})

		return {
			tool,
			invoked: Deferred.await(invoked),
			release: Deferred.succeed(gate, undefined).pipe(Effect.asVoid),
		}
	})

/** Handle to a partial-hang model: first request streams `prefixText` deltas and then hangs. */
export type PartialHangModel = {
	readonly model: FoldModel
	/** Succeeds once the hanging (first) request has streamed its prefix deltas. */
	readonly firstRequestStreaming: Effect.Effect<void>
	/** Every prompt sent to the model, in request order. */
	readonly prompts: Effect.Effect<ReadonlyArray<unknown>>
}

/**
 * A model whose FIRST streamText call emits text deltas for `prefixText`, signals, and then never
 * finishes - the target for partial-flush interrupt tests - while every later call (the run after
 * resume) serves the given scripted turns.
 */
export const makePartialHangModel = (
	activeModel: ActiveModel,
	prefixText: string,
	laterTurns: ReadonlyArray<ScriptedTurn>,
): Effect.Effect<PartialHangModel> =>
	Effect.gen(function* () {
		const firstRequestStreaming = yield* Deferred.make<void>()
		const hungOnce = yield* Ref.make(false)
		const turnsRef = yield* Ref.make<ReadonlyArray<ScriptedTurn>>(laterTurns)
		const promptsRef = yield* Ref.make<ReadonlyArray<unknown>>([])

		const prefixParts: ReadonlyArray<Response.StreamPartEncoded> = [
			{ type: 'text-start', id: 'text-1' },
			{ type: 'text-delta', id: 'text-1', delta: prefixText },
		]

		const make = LanguageModel.make({
			generateText: () => Effect.die(new Error('partial-hang model supports streamText only')),
			streamText: (options) =>
				Stream.unwrap(
					Effect.gen(function* () {
						yield* Ref.update(promptsRef, (prompts) => [...prompts, options.prompt])

						const alreadyHung = yield* Ref.getAndSet(hungOnce, true)
						if (!alreadyHung) {
							// Stream the prefix deltas, signal, then hang: the interruption strikes mid-turn
							// with real partial text already seen by the loop's delta tap.
							return Stream.fromIterable(prefixParts).pipe(
								Stream.concat(
									Stream.fromEffect(
										Deferred.succeed(firstRequestStreaming, undefined).pipe(
											Effect.andThen(Effect.never),
										),
									),
								),
							)
						}

						const remaining = yield* Ref.get(turnsRef)
						const turn = remaining[0]
						if (turn === undefined) {
							return yield* Effect.die(new Error('partial-hang model: later script exhausted'))
						}
						yield* Ref.set(turnsRef, remaining.slice(1))

						return turn._tag === 'failure'
							? Stream.fail(
									AiError.make({
										module: 'PartialHangModel',
										method: 'streamText',
										reason: new AiError.UnknownError({ description: turn.message }),
									}),
								)
							: Stream.fromIterable(turn.parts)
					}),
				),
		})

		return {
			model: customModel({ activeModel, make }),
			firstRequestStreaming: Deferred.await(firstRequestStreaming),
			prompts: Ref.get(promptsRef),
		}
	})
