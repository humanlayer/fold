/**
 * This file defines the ergonomic tool constructor for the public API: `defineTool` describes a tool's
 * name, description, schemas, and handler in one place (the review's `Tool.inline` shape). The result is
 * a plain descriptor - no Toolkit, handler layer, or Toolset plumbing appears in caller code; the Session
 * composition root lowers a list of these descriptors into the installed Toolset.
 */
import { Effect, Schema } from 'effect'
import { Tool } from 'effect/unstable/ai'

import { StopController, ToolEvents } from '../ToolRuntime/ToolContextServices'
import { ToolState } from '../ToolRuntime/ToolStateService'

/**
 * Ambient services every tool handler may use: durable per-call `ToolState` (through declared
 * `defineToolState` namespaces), ephemeral `ToolEvents` progress, and the cooperative `StopController`.
 * The runtime provides them around each call; handlers needing none of them simply have a smaller `R`.
 */
export type ToolHandlerServices = ToolState | ToolEvents | StopController

/** Handler stored on a tool descriptor, erased to the runtime dispatch shape. */
type ErasedToolHandler = (params: unknown) => Effect.Effect<unknown, unknown, ToolHandlerServices>

/**
 * One user-defined tool: schema description plus handler, ready to install on an agent. Built with
 * {@link defineTool}; consumed by `startSession`, which assembles all of an agent's tools into the
 * runtime Toolset.
 */
export type TartTool = {
	readonly name: string
	/** The lowered Effect AI tool definition advertised to the model. */
	readonly tool: Tool.Any
	/** The handler, erased for dynamic dispatch; only ever invoked with schema-decoded parameters. */
	readonly handler: ErasedToolHandler
}

/** Options for {@link defineTool}. Schemas default to no parameters, void success, and no failure. */
export type DefineToolOptions<Params extends Schema.Top, Success extends Schema.Top, Failure extends Schema.Top> = {
	readonly name: string
	readonly description: string
	/** Parameter schema advertised to the model. Defaults to an empty struct (no parameters). */
	readonly parameters?: Params
	/** Success schema for the handler result. Defaults to void. */
	readonly success?: Success
	/** Failure schema for expected, model-visible failures. Defaults to never (handler cannot fail). */
	readonly failure?: Failure
	readonly handler: (params: Params['Type']) => Effect.Effect<Success['Type'], Failure['Type'], ToolHandlerServices>
}

/**
 * Define one tool inline: name, description, schemas, and handler in a single object.
 *
 * Expected failures follow the D12 convention (`failureMode: "return"`): a typed failure from the
 * handler is schema-encoded into the tool result with `isFailure: true`, so the model sees it and can
 * self-correct; defects stay defects and are captured at the tool-settlement seam.
 *
 * When `success` is omitted the handler is typed as returning void, but the lowered tool uses
 * `Schema.Undefined` (with results normalized to undefined) rather than Effect AI's default
 * `Schema.Void`: results encode through `Union([success, failure, AiError])`, and Void greedily
 * encodes any value - including a returned failure - to undefined, which would erase the failure
 * payload the model needs to self-correct.
 */
export const defineTool = <
	Params extends Schema.Top = Tool.EmptyParams,
	Success extends Schema.Top = typeof Schema.Void,
	Failure extends Schema.Top = typeof Schema.Never,
>(
	options: DefineToolOptions<Params, Success, Failure>,
): TartTool => {
	const tool = Tool.make(options.name, {
		description: options.description,
		...(options.parameters === undefined ? {} : { parameters: options.parameters }),
		success: options.success ?? Schema.Undefined,
		...(options.failure === undefined ? {} : { failure: options.failure }),
		failureMode: 'return',
		// Every tool may use the ambient per-call services; declaring them here keeps handler `R`
		// honest while the runtime provides all three around each execution.
		dependencies: [ToolState, ToolEvents, StopController],
	})

	// asVoid yields the undefined value at runtime, which is exactly what Schema.Undefined encodes.
	const handler =
		options.success === undefined
			? (params: Params['Type']) => options.handler(params).pipe(Effect.asVoid)
			: options.handler

	return {
		name: options.name,
		tool,
		// SAFETY: the handler is stored erased so heterogeneous tools can share one dispatch table.
		// Effect AI decodes model-supplied params against `parameters` before invoking the handler,
		// so it is only ever called with values of `Params['Type']`.
		// oxlint-disable-next-line typescript/consistent-type-assertions
		handler: handler as ErasedToolHandler,
	}
}
