/**
 * This file defines the schema-first domain types for the Subagents service (D21). Schemas are the
 * source of truth and the TypeScript types are derived from them; SubagentOutcome deliberately reuses
 * the agent-finished vocabulary rather than inventing a parallel one, so a subagent result and its
 * durable terminal marker can never disagree about what outcomes exist. The subagent tool's flat wire
 * parameters (kept flat because schema unions confuse models - D21 ruling) parse HERE into the
 * `SubagentCommand` union at one boundary: parse, don't validate.
 */
import { Effect, Schema } from 'effect'

import { AgentFinishedOutcome } from '../EventLog/Schemas'
import { AgentId } from '../Ids'
import { AgentIdRef } from './AgentIdRef'
import { InvalidSubagentCommandError } from './Errors'

/** Count of assistant turns (one LLM call each, D7 vocabulary) - a pure fold over assistant-message rows. */
export const TurnCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ identifier: 'TurnCount' })
export type TurnCount = typeof TurnCount.Type

/** Outcome of a subagent run - the same closed vocabulary as agent-finished entries. */
export const SubagentOutcome = AgentFinishedOutcome
export type SubagentOutcome = typeof SubagentOutcome.Type

/**
 * Result of one subagent dispatch, fork, or resume, as returned by the Subagents service. A subagent
 * that errored, died, or was interrupted is still a result (its agent-finished marker is in the log);
 * the dispatching model sees it rendered and may resume the subagent by id.
 */
export const SubagentResult = Schema.Struct({
	agentId: AgentId,
	outcome: SubagentOutcome,
	/** The subagent's final assistant text this run, or null when it produced none. */
	resultText: Schema.NullOr(Schema.String),
	/** Model-visible error description; non-null exactly when outcome is "error". */
	errorMessage: Schema.NullOr(Schema.String),
	/** Assistant turns under the current dispatch/resume tool call. */
	turnsThisRun: TurnCount,
	/** Assistant turns across the subagent's whole life (differs from turnsThisRun after a resume). */
	turnsTotal: TurnCount,
}).annotate({ identifier: 'SubagentResult' })
export type SubagentResult = typeof SubagentResult.Type

/** Dispatch a fresh subagent of a registered type. */
export const DispatchSubagentCommand = Schema.TaggedStruct('dispatch', {
	agent: Schema.String,
	prompt: Schema.String,
	skill: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'DispatchSubagentCommand' })
export type DispatchSubagentCommand = typeof DispatchSubagentCommand.Type

/** Resume a previously dispatched subagent by reference: its full id or a unique short prefix. */
export const ResumeSubagentCommand = Schema.TaggedStruct('resume', {
	agentId: AgentIdRef,
	prompt: Schema.String,
	skill: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'ResumeSubagentCommand' })
export type ResumeSubagentCommand = typeof ResumeSubagentCommand.Type

/** Fork the dispatching agent: a clone of its context, config, and toolset. */
export const ForkSubagentCommand = Schema.TaggedStruct('fork', {
	prompt: Schema.String,
	skill: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'ForkSubagentCommand' })
export type ForkSubagentCommand = typeof ForkSubagentCommand.Type

/** One parsed subagent tool invocation - exactly one of dispatch, resume, or fork. */
export const SubagentCommand = Schema.Union([
	DispatchSubagentCommand,
	ResumeSubagentCommand,
	ForkSubagentCommand,
]).annotate({ identifier: 'SubagentCommand' })
export type SubagentCommand = typeof SubagentCommand.Type

const decodeAgentIdRef = Schema.decodeUnknownEffect(AgentIdRef)

/** The subagent tool's flat wire parameters, as decoded by Effect AI against the tool contract. */
export type SubagentToolWireParameters = {
	readonly prompt: string
	readonly skill?: string
	readonly agent?: string
	readonly agent_id?: string
	readonly fork?: boolean
}

/**
 * Parse the tool's flat wire parameters into exactly one {@link SubagentCommand}. The wire shape stays
 * flat because schema unions confuse models (D21 ruling); this is the single boundary where it becomes
 * a typed command - exactly-one-of violations and malformed ids are parse failures with instructive,
 * model-facing messages, never ad-hoc validation in the handler.
 */
export const parseSubagentCommand = (
	params: SubagentToolWireParameters,
): Effect.Effect<SubagentCommand, InvalidSubagentCommandError> =>
	Effect.gen(function* () {
		const skill = params.skill ?? null
		const selectorCount = [params.agent !== undefined, params.agent_id !== undefined, params.fork === true].filter(
			Boolean,
		).length

		if (selectorCount !== 1) {
			return yield* new InvalidSubagentCommandError({
				message:
					'Provide exactly one of agent (dispatch a fresh subagent), agent_id (resume a previous ' +
					'subagent), or fork: true (copy your own context).',
			})
		}

		if (params.agent !== undefined) {
			return { _tag: 'dispatch', agent: params.agent, prompt: params.prompt, skill } as const
		}
		if (params.fork === true) {
			return { _tag: 'fork', prompt: params.prompt, skill } as const
		}

		const agentId = yield* decodeAgentIdRef(params.agent_id).pipe(
			Effect.mapError(
				() =>
					new InvalidSubagentCommandError({
						message:
							`agent_id "${params.agent_id ?? ''}" is not a valid subagent id. Use the agent_id line ` +
							`from a previous subagent result, or dispatch a fresh agent with the agent parameter.`,
					}),
			),
		)

		return { _tag: 'resume', agentId, prompt: params.prompt, skill } as const
	})
