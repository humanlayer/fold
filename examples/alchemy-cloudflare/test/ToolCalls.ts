/**
 * Call a fold tool's handler outside a session. fold provides these services around every tool call; here
 * they are stubs. Platform services (FileSystem, Path) are the caller's to provide.
 */
import {
	AgentId,
	CurrentAgent,
	CurrentToolCall,
	InterruptNote,
	StopController,
	Subagents,
	ToolCallId,
	ToolEvents,
	ToolState,
	type FoldTool,
} from '@humanlayer/fold-core'
import { Effect, Layer } from 'effect'

const toolCallServices = Layer.mergeAll(
	Layer.succeed(ToolState, { get: () => Effect.succeed(null), set: () => Effect.void }),
	Layer.succeed(ToolEvents, { emit: () => Effect.void }),
	Layer.succeed(StopController, { requestStop: () => Effect.void, isStopRequested: Effect.succeed(false) }),
	Layer.succeed(CurrentAgent, { agentId: AgentId.create(), parentAgentId: null }),
	Layer.succeed(CurrentToolCall, { toolCallId: ToolCallId.create() }),
	Layer.succeed(InterruptNote, { set: () => Effect.void }),
	Layer.succeed(Subagents, {
		dispatch: () => Effect.die('no subagents'),
		fork: () => Effect.die('no subagents'),
		resume: () => Effect.die('no subagents'),
		continueSubagent: () => Effect.die('no subagents'),
	}),
)

/** Run the tool named `name` from `tools` with `params`, as the model would call it. */
export const callTool = (tools: ReadonlyArray<FoldTool>, name: string, params: unknown) => {
	const tool = tools.find((candidate) => candidate.name === name)
	if (tool === undefined) return Effect.die(`no ${name} tool`)
	return tool.init.pipe(
		Effect.flatMap((contribution) => contribution.handler(params)),
		Effect.provide(toolCallServices),
	)
}
