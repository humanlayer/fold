/**
 * This file builds a Toolset layer from an Effect AI Toolkit and its handler layer. Application setup code
 * consumes this adapter to install concrete tools, and ToolRuntime consumes the resulting Toolset service
 * without needing to know the toolkit's specific TypeScript shape.
 */
import { Effect, Layer, Stream } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'

import { Toolset, type ToolHandlerOutput } from './ToolsetService'

/** Build a final failure output for a model-requested tool name that is not in the active Toolset. */
const unavailableToolFailureOutput = (name: string, names: ReadonlyArray<string>): ToolHandlerOutput => ({
	result: { message: `Tool "${name}" is not available.`, availableTools: names },
	encodedResult: { message: `Tool "${name}" is not available.`, availableTools: names },
	isFailure: true,
	preliminary: false,
})

/** Build a final failure output when handler lookup or stream creation fails before execution starts. */
const toolStartupFailureOutput = (name: string, cause: unknown): ToolHandlerOutput => ({
	result: { message: `Tool "${name}" failed before execution.`, cause: String(cause) },
	encodedResult: { message: `Tool "${name}" failed before execution.`, cause: String(cause) },
	isFailure: true,
	preliminary: false,
})

/** Build the Toolset layer that exposes one concrete Effect AI Toolkit to ToolRuntime. */
export const toolsetLayerFromToolkit = <Tools extends Record<string, Tool.Any>>(
	toolkit: Toolkit.Toolkit<Tools>,
): Layer.Layer<Toolset, never, Tool.HandlersFor<Tools>> =>
	Layer.effect(
		Toolset,
		Effect.gen(function* () {
			// SAFETY: Toolkit's `handle` is typed for statically-known tool names, but this seam
			// dispatches model-supplied names at runtime (guarded by `names.includes` below). TypeScript
			// cannot express dynamic dispatch over a heterogeneous toolkit; the library erases internally
			// for the same reason (Toolkit.ts: `handle: handle as any`). The one sanctioned assertion.
			// oxlint-disable-next-line typescript/consistent-type-assertions
			const withHandlers = (yield* toolkit) as unknown as Toolkit.WithHandler<Record<string, Tool.Any>>
			const names = Object.keys(toolkit.tools)

			return {
				names: Effect.succeed(names),
				toolkit: Effect.succeed(toolkit),
				withHandler: Effect.succeed(withHandlers),

				/** Run one named toolkit handler, mapping unavailable tools and startup failures to final outputs. */
				handle: (name, params) => {
					if (!names.includes(name))
						return Effect.succeed(Stream.succeed(unavailableToolFailureOutput(name, names)))

					return withHandlers.handle(name, params).pipe(
						Effect.matchEffect({
							onFailure: (cause) => Effect.succeed(Stream.succeed(toolStartupFailureOutput(name, cause))),
							onSuccess: (stream) =>
								Effect.succeed(
									stream.pipe(
										Stream.map(
											(output): ToolHandlerOutput => ({
												result: output.result,
												encodedResult: output.encodedResult,
												isFailure: output.isFailure,
												preliminary: output.preliminary,
											}),
										),
										Stream.mapError((error): unknown => error),
									),
								),
						}),
					)
				},
			}
		}),
	)
