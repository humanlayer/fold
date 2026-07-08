/**
 * This file defines the Subagents service contract (D21) - dispatch, fork, and resume subagents on the
 * session log. The deep module behind it owns choreography, fibers, finalizers, roster enforcement,
 * and result folding; the subagent tool is a thin adapter over these three methods. Every method runs
 * inside a tool call: the executing call's identity and interrupt note arrive as ambient services
 * (CurrentAgent / CurrentToolCall / InterruptNote, provided by ToolRuntime around each handler), and
 * the dispatch authority - which types this caller may launch - arrives as `allowedAgents` from the
 * executing subagentTool value's closure (round-five roster model).
 */
import { Context } from 'effect'
import type { Effect } from 'effect'

import type { AgentFinishedLogEntry } from '../EventLog/Schemas'
import type { AgentId } from '../Ids'
import type { SkillNotFoundError } from '../Skills/SkillSource'
import type { CurrentAgent, CurrentToolCall, InterruptNote } from '../ToolRuntime/ToolContextServices'
import type { SubagentBusyError, SubagentNotFoundError, SubagentTypeNotInRosterError } from './Errors'
import type { SubagentResult } from './Schemas'

/** Ambient per-tool-call services every Subagents method consumes. */
export type SubagentAmbientServices = CurrentAgent | CurrentToolCall | InterruptNote

/** Input for dispatching one fresh subagent of a registered type. */
export type DispatchSubagentInput = {
	/** The requested agent type name. */
	readonly agent: string
	readonly prompt: string
	/** Skill to preload after the prompt, resolved through the dispatcher's own skillTool source. */
	readonly skill: string | null
	/** The executing subagentTool value's roster (from its closure) - the dispatch authority (§1a). */
	readonly allowedAgents: ReadonlyArray<string>
}

/** Input for forking the dispatching agent: the fork clones its context, config, and toolset. */
export type ForkSubagentInput = {
	readonly prompt: string
	readonly skill: string | null
}

/** Input for resuming a previously dispatched subagent by id. */
export type ResumeSubagentInput = {
	readonly agentId: AgentId
	readonly prompt: string
	readonly skill: string | null
}

/** Input for continuing a finished subagent directly from the SDK (D8 `send(message, { agentId })`). */
export type ContinueSubagentInput = {
	readonly agentId: AgentId
	readonly prompt: string
}

/**
 * Subagent lifecycle operations (D21).
 *
 * A subagent that errors, dies with a defect, or is interrupted is a *result*, not a failure: its
 * terminal `agent-finished` marker is durable and the returned SubagentResult carries the outcome,
 * error message, and turn counts, so the dispatcher can render it and later resume the subagent by id.
 * The typed failures below are the *dispatch-time* problems the model can act on: an out-of-roster
 * type, an unknown id, a concurrent resume, or a bad skill preload.
 */
export type SubagentsService = {
	readonly dispatch: (
		input: DispatchSubagentInput,
	) => Effect.Effect<SubagentResult, SubagentTypeNotInRosterError | SkillNotFoundError, SubagentAmbientServices>
	readonly fork: (
		input: ForkSubagentInput,
	) => Effect.Effect<SubagentResult, SkillNotFoundError, SubagentAmbientServices>
	readonly resume: (
		input: ResumeSubagentInput,
	) => Effect.Effect<
		SubagentResult,
		SubagentNotFoundError | SubagentBusyError | SkillNotFoundError,
		SubagentAmbientServices
	>
	/**
	 * Continue a finished subagent from the SDK, with no dispatching tool call (D8): the prompt appends
	 * as a user message with a null toolCallId/parentAgentId envelope, the agent's loop restarts under
	 * its own configuration (running the D17 model transition first when its binding changed), and the
	 * caller gets the durable terminal entry - interrupts and defects included, via their durable
	 * markers. Requires no ambient tool-call services; this is the facade's `send(text, { agentId })`.
	 */
	readonly continueSubagent: (
		input: ContinueSubagentInput,
	) => Effect.Effect<AgentFinishedLogEntry, SubagentNotFoundError | SubagentBusyError>
}

/**
 * Subagents service tag. Provided to tool handlers as an ambient per-call service by ToolRuntime (the
 * subagentTool handler yields it); preset tests substitute a scripted implementation here.
 */
export class Subagents extends Context.Service<Subagents, SubagentsService>()('tart/Subagents') {}
