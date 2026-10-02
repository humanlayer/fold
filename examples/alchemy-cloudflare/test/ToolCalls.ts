/**
 * Call a fold tool's handler outside a session, decoding its erased result back to the tool result schemas. fold provides these services around every tool call; here
 * they are stubs. Platform services (FileSystem, Path) are the caller's to provide.
 */
import {
	AgentId,
	CurrentAgent,
	CurrentToolCall,
	InterruptNote,
	StopController,
	ToolCallId,
	ToolEvents,
	ToolResultFailure,
	ToolResultSuccess,
	ToolState,
	type FoldTool,
} from '@humanlayer/fold-core'
import { Effect, Layer, Schema } from 'effect'

const toolCallServices = Layer.mergeAll(
	Layer.succeed(ToolState, { get: () => Effect.succeed(null), set: () => Effect.void }),
	Layer.succeed(ToolEvents, { emit: () => Effect.void }),
	Layer.succeed(StopController, { requestStop: () => Effect.void, isStopRequested: Effect.succeed(false) }),
	Layer.succeed(CurrentAgent, { agentId: AgentId.create(), parentAgentId: null }),
	Layer.succeed(CurrentToolCall, { toolCallId: ToolCallId.create() }),
	Layer.succeed(InterruptNote, { set: () => Effect.void }),
)

/** Run the tool named `name` from `tools` with `params`, as the model would call it. */
export const callTool = <R>(tools: ReadonlyArray<FoldTool<R>>, name: string, params: unknown) => {
	const tool = tools.find((candidate) => candidate.name === name)
	if (tool === undefined) return Effect.die(`no ${name} tool`)
	return tool.init.pipe(
		Effect.flatMap((contribution) =>
			// oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- the erased handler is decoded here
			contribution.handler(params).pipe(
				Effect.catch((error) =>
					Schema.decodeUnknownEffect(ToolResultFailure)(error).pipe(
						Effect.orDie,
						Effect.flatMap(Effect.fail),
					),
				),
				Effect.flatMap((result) => Schema.decodeUnknownEffect(ToolResultSuccess)(result).pipe(Effect.orDie)),
			),
		),
		Effect.provide(toolCallServices),
	)
}
