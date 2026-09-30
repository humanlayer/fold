/**
 * This file defines the ergonomic tool constructor for the public API: `defineTool` describes a tool's
 * name, description, schemas, and handler in one place (the review's `Tool.inline` shape). The result is
 * a plain descriptor - no Toolkit, handler layer, or Toolset plumbing appears in caller code; the Session
 * composition root lowers a list of these descriptors into the installed Toolset.
 *
 * Every configured tool has ONE shape: a name plus an `init` Effect the composition root runs exactly
 * once per distinct value per session, yielding the tool's session contribution (realized definition,
 * handler, optional leading-prompt block). For ordinary tools `defineTool` lowers to a constant init;
 * system tools whose surface is configuration-derived - the skill tool bakes a session-start roster
 * scan into its description and contributes the skills prompt block - do real work in theirs. Sharing
 * the same value across several agents' `tools` arrays shares one init (one scan, one snapshot).
 */
import { Effect, Schema, type Scope } from 'effect'
import { Tool } from 'effect/unstable/ai'

import type { SkillSourceService } from '../Skills/SkillSource'
import { Subagents } from '../Subagents/SubagentsService'
import type { SubagentToolCapabilities } from '../Subagents/SubagentTool'
import {
	CurrentAgent,
	CurrentToolCall,
	InterruptNote,
	StopController,
	ToolEvents,
} from '../ToolRuntime/ToolContextServices'
import { ToolState } from '../ToolRuntime/ToolStateService'

/**
 * Ambient services every tool handler may use: durable per-call `ToolState` (through declared
 * `defineToolState` namespaces), ephemeral `ToolEvents` progress, the cooperative `StopController`,
 * the executing call's identity (`CurrentAgent`/`CurrentToolCall` - D12), the `InterruptNote` enriching
 * this call's synthetic result if it is interrupted, and the `Subagents` engine (the subagent tool's
 * handler delegates to it). The runtime provides all of them around each call; handlers needing none of
 * them simply have a smaller `R`. Anything else a handler needs (a filesystem, an HTTP client, a host
 * service) becomes part of the tool's own type, {@link FoldTool}, and the host provides it at the top.
 */
export type ToolHandlerServices =
	| ToolState
	| ToolEvents
	| StopController
	| CurrentAgent
	| CurrentToolCall
	| InterruptNote
	| Subagents

type ToolDependency =
	| typeof ToolState
	| typeof ToolEvents
	| typeof StopController
	| typeof CurrentAgent
	| typeof CurrentToolCall
	| typeof InterruptNote
	| typeof Subagents

type ToolOptionsBuilder<Params extends Schema.Top, Success extends Schema.Top, Failure extends Schema.Top> = {
	description: string
	parameters?: Params
	success: Success | typeof Schema.Undefined
	failure?: Failure
	failureMode: 'return'
	dependencies: Array<ToolDependency>
}

/** Handler stored on a tool descriptor, erased to the runtime dispatch shape (Effect AI's erased tool params). */
export type ErasedToolHandler = (
	params: Tool.Parameters<Tool.Any>,
) => Effect.Effect<unknown, unknown, ToolHandlerServices>

/**
 * What one tool contributes to a session once its `init` has run: the realized tool definition (final
 * description baked), its handler, and an optional block appended to the leading system prompt of
 * every agent listing the value.
 */
export type SessionToolContribution = {
	readonly tool: Tool.Any
	readonly handler: ErasedToolHandler
	/** Appended to the leading prompt blocks of each agent whose `tools` carry this value. */
	readonly promptBlock: string | null
	/**
	 * The resolved skill source, when this contribution is a skill tool's - the seam the Subagents
	 * service preloads dispatch-time skills through (the dispatcher picks from skills *it* can see).
	 */
	readonly skillSource?: SkillSourceService
}

/**
 * One tool as configured on an agent, ready for the composition root to initialize. Built with
 * {@link defineTool} or a system-tool factory (`skillTool`, `subagentTool`); consumed by `startSession`
 * and by subagent definitions. `R` is every service the tool needs from the host - its handler's and its
 * init's - so an agent's type, and `startSession`'s, carry what the host must provide.
 */
export type FoldTool<R = never> = {
	readonly name: string
	/**
	 * Run ONCE per distinct value per session by the composition root; contributions are reused. Resources
	 * it acquires live for the session's scope. Its handler runs with the same host services.
	 */
	readonly init: Effect.Effect<SessionToolContribution, never, R | Scope.Scope>
	/** The subagent roster, on delegation tools built by `subagentTool` or `withSubagentCapabilities`. */
	readonly subagents?: SubagentToolCapabilities<R>
}

/** The host services a tool, or a union of tools, needs (the session always supplies `Scope` itself). */
export type FoldToolServices<T> = T extends { readonly init: Effect.Effect<infer _A, infer _E, infer R> }
	? Exclude<R, Scope.Scope>
	: never

/**
 * View a list of tools as tools needing the union of their services. TypeScript infers a mixed array's
 * element type as a union of tools, but cannot infer one service union across the elements, so the
 * public constructors take the tools' own type and convert once here.
 */
export const toolsNeedingAll = <T extends FoldTool<unknown>>(
	tools: ReadonlyArray<T>,
): ReadonlyArray<FoldTool<FoldToolServices<T>>> =>
	// SAFETY: each element is a FoldTool<R> whose R is one member of FoldToolServices<T>, and FoldTool is
	// covariant in R, so each is a FoldTool<FoldToolServices<T>>. TypeScript cannot see through the
	// conditional type for a generic T.
	// oxlint-disable-next-line typescript/consistent-type-assertions, automation/no-type-assertion
	tools as ReadonlyArray<FoldTool<FoldToolServices<T>>>

/** One realized tool ready to install into a Toolset: the composition-internal, post-init stage. */
export type RealizedFoldTool = {
	readonly name: string
	readonly tool: Tool.Any
	readonly handler: ErasedToolHandler
}

/** Options for {@link defineTool}. Schemas default to no parameters, void success, and no failure. */
export type DefineToolOptions<
	Params extends Schema.Top,
	Success extends Schema.Top,
	Failure extends Schema.Top,
	Services = never,
> = {
	readonly name: string
	readonly description: string
	/** Parameter schema advertised to the model. Defaults to an empty struct (no parameters). */
	readonly parameters?: Params
	/** Success schema for the handler result. Defaults to void. */
	readonly success?: Success
	/** Failure schema for expected, model-visible failures. Defaults to never (handler cannot fail). */
	readonly failure?: Failure
	/**
	 * The handler may use the per-call {@link ToolHandlerServices} plus any host service; the host ones
	 * become the tool's `R` and the host provides them where it starts the session.
	 */
	readonly handler: (params: Params['Type']) => Effect.Effect<Success['Type'], Failure['Type'], Services>
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
	Services = never,
>(
	options: DefineToolOptions<Params, Success, Failure, Services>,
): FoldTool<Exclude<Services, ToolHandlerServices>> => {
	const toolOptions: ToolOptionsBuilder<Params, Success, Failure> = {
		description: options.description,
		success: options.success ?? Schema.Undefined,
		failureMode: 'return',
		// Every tool may use the ambient per-call services; declaring them here keeps handler `R`
		// honest while the runtime provides all of them around each execution.
		dependencies: [ToolState, ToolEvents, StopController, CurrentAgent, CurrentToolCall, InterruptNote, Subagents],
	}
	if (options.parameters !== undefined) {
		toolOptions.parameters = options.parameters
	}
	if (options.failure !== undefined) {
		toolOptions.failure = options.failure
	}
	const tool = Tool.make(options.name, toolOptions).annotate(Tool.Strict, false)

	// asVoid yields the undefined value at runtime, which is exactly what Schema.Undefined encodes.
	const handler =
		options.success === undefined
			? (params: Params['Type']) => options.handler(params).pipe(Effect.asVoid)
			: options.handler

	return {
		name: options.name,
		init: Effect.succeed({
			tool,
			// SAFETY: the handler is stored erased so heterogeneous tools can share one dispatch table. Effect
			// AI decodes model-supplied params against `parameters` before invoking it, so it only ever receives
			// `Params['Type']`. The runtime provides the per-call services around each call, and the host
			// services in `Services` come from the session's services, which `startSession` requires from its
			// caller because this tool's type carries them.
			// oxlint-disable-next-line typescript/consistent-type-assertions, automation/no-type-assertion
			handler: handler as ErasedToolHandler,
			promptBlock: null,
		}),
	}
}
