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
import { type Context, Effect, FileSystem, Layer, Path, Schema, type Scope } from 'effect'
import { Tool } from 'effect/unstable/ai'
import { ChildProcessSpawner } from 'effect/unstable/process'

import type { SkillSourceService } from '../Skills/SkillSource'
import { Subagents } from '../Subagents/SubagentsService'
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
 * them simply have a smaller `R`. Platform services are not among them: see {@link PlatformServices}.
 */
export type ToolHandlerServices =
	| ToolState
	| ToolEvents
	| StopController
	| CurrentAgent
	| CurrentToolCall
	| InterruptNote
	| Subagents

/**
 * Host services that disk- and process-backed descriptors (coding tools, a JSONL log, a disk skill
 * source) may declare. A session never requires them: it passes along whichever ones its caller
 * provides, so a host without a filesystem can run any session whose descriptors don't declare one.
 */
export type PlatformServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

type ToolDependency =
	| typeof ToolState
	| typeof ToolEvents
	| typeof StopController
	| typeof CurrentAgent
	| typeof CurrentToolCall
	| typeof InterruptNote
	| typeof Subagents
	| typeof FileSystem.FileSystem
	| typeof Path.Path
	| typeof ChildProcessSpawner.ChildProcessSpawner

type ToolOptionsBuilder<Params extends Schema.Top, Success extends Schema.Top, Failure extends Schema.Top> = {
	description: string
	parameters?: Params
	success: Success | typeof Schema.Undefined
	failure?: Failure
	failureMode: 'return'
	dependencies: Array<ToolDependency>
}

/** Neutral platform services used by filesystem and process-backed tools. */
export const platformToolDependencies = [
	FileSystem.FileSystem,
	Path.Path,
	ChildProcessSpawner.ChildProcessSpawner,
] as const

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
 * and by subagent definitions.
 */
export type FoldTool = {
	readonly name: string
	/**
	 * Run ONCE per distinct value per session by the composition root; contributions are reused. Resources
	 * it acquires (such as a tool's own services) live for the session's scope.
	 */
	readonly init: Effect.Effect<SessionToolContribution, never, PlatformServices | Scope.Scope>
}

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
	readonly dependencies?: typeof platformToolDependencies
	/**
	 * Services this tool's handler needs beyond the per-call and platform services. The session builds the
	 * layer once, when the tool is initialized, and every call of this tool uses the same services.
	 */
	readonly layer?: Layer.Layer<Services, never, PlatformServices>
	readonly handler: (
		params: Params['Type'],
	) => Effect.Effect<Success['Type'], Failure['Type'], ToolHandlerServices | PlatformServices | Services>
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
): FoldTool => {
	const toolOptions: ToolOptionsBuilder<Params, Success, Failure> = {
		description: options.description,
		success: options.success ?? Schema.Undefined,
		failureMode: 'return',
		// Every tool may use the ambient per-call services; declaring them here keeps handler `R`
		// honest while the runtime provides all of them around each execution.
		dependencies: [
			ToolState,
			ToolEvents,
			StopController,
			CurrentAgent,
			CurrentToolCall,
			InterruptNote,
			Subagents,
			...(options.dependencies ?? []),
		],
	}
	if (options.parameters !== undefined) {
		toolOptions.parameters = options.parameters
	}
	if (options.failure !== undefined) {
		toolOptions.failure = options.failure
	}
	const tool = Tool.make(options.name, toolOptions).annotate(Tool.Strict, false)

	// asVoid yields the undefined value at runtime, which is exactly what Schema.Undefined encodes.
	const handlerWithDependencies =
		options.success === undefined
			? (params: Params['Type']) => options.handler(params).pipe(Effect.asVoid)
			: options.handler
	const withToolServices =
		(context: Context.Context<Services>) =>
		(params: Params['Type']): Effect.Effect<unknown, unknown, ToolHandlerServices | PlatformServices> =>
			handlerWithDependencies(params).pipe(Effect.provideContext(context))
	const contributionFor = (
		handlerWithServices: (
			params: Params['Type'],
		) => Effect.Effect<unknown, unknown, ToolHandlerServices | PlatformServices | Services>,
	): SessionToolContribution => ({
		tool,
		// SAFETY: the handler is stored erased so heterogeneous tools can share one dispatch table. Effect AI
		// decodes model-supplied params against `parameters` before invoking it, so it only ever receives
		// `Params['Type']`, and supplies the platform services declared by `dependencies`; the erased table
		// retains only Fold's per-call services because collected tools cannot keep their own dependency rows.
		// `Services` is already provided when `layer` is set, and is `never` when it is omitted.
		// oxlint-disable-next-line typescript/consistent-type-assertions, automation/no-type-assertion
		handler: handlerWithServices as ErasedToolHandler,
		promptBlock: null,
	})

	return {
		name: options.name,
		init:
			options.layer === undefined
				? Effect.succeed(contributionFor(handlerWithDependencies))
				: Layer.build(options.layer).pipe(Effect.map((context) => contributionFor(withToolServices(context)))),
	}
}
