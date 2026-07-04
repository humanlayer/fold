/**
 * This file defines the Toolset service - the active toolkit advertised to the model and used by the
 * ToolRuntime live layer to execute tool handlers. The service keeps Effect AI's dynamic Toolkit boundary
 * contained so callers do not pass tool handlers around as arguments.
 */
import { Context, Effect, Stream } from 'effect'
import { Toolkit } from 'effect/unstable/ai'

/** Type-erased handler output from Effect AI Toolkit. Preliminary outputs are UI/progress only. */
export type ToolHandlerOutput = {
	readonly result: unknown
	readonly encodedResult: unknown
	readonly isFailure: boolean
	readonly preliminary: boolean
}

/** Tool definitions plus a dynamic handler execution seam. */
export type ToolsetService = {
	/** Return the tool names currently advertised to the model. */
	readonly names: Effect.Effect<ReadonlyArray<string>>
	/** Return the underlying Effect AI Toolkit so prompt construction can advertise its schemas. */
	readonly toolkit: Effect.Effect<Toolkit.Any>
	/** Run one named handler with model-supplied parameters and stream its toolkit outputs. */
	readonly handle: (name: string, params: unknown) => Effect.Effect<Stream.Stream<ToolHandlerOutput, unknown>>
}

/** Active toolset shared by AgentRuntime and ToolRuntime. */
export class Toolset extends Context.Service<Toolset, ToolsetService>()('tart/Toolset') {}
