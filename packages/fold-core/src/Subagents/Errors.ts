/**
 * This file defines the expected failures of the Subagents service (D21). Each error models the
 * dispatching model's recovery action - pick from the listed roster, check the id, or wait - and the
 * subagent tool encodes them into instructive `failureMode: "return"` payloads so the model
 * self-corrects instead of the run failing.
 */
import { Schema } from 'effect'

import { AgentId } from '../Ids'

/**
 * The requested agent type is not in the dispatching agent's roster (unknown to the session, or known
 * but not granted to this dispatcher - the two are deliberately indistinguishable to the caller).
 */
export class SubagentTypeNotInRosterError extends Schema.TaggedErrorClass<SubagentTypeNotInRosterError>()(
	'SubagentTypeNotInRosterError',
	{
		requested: Schema.String,
		/** The agent types this dispatcher may launch. */
		availableAgents: Schema.Array(Schema.String),
	},
) {}

/**
 * No agent uniquely matches this reference on the session log: either no agent was ever started under
 * it, or - when `candidates` is present - a short reference prefix-matched two or more agents and the
 * caller must provide more characters.
 */
export class SubagentNotFoundError extends Schema.TaggedErrorClass<SubagentNotFoundError>()('SubagentNotFoundError', {
	/** The raw reference the caller passed (may not even be a well-formed agent id). */
	requested: Schema.String,
	/** Set when the reference was ambiguous: the SHORT ids of every agent it matched. */
	candidates: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

/** The agent is currently running (or is a running ancestor) and cannot be resumed concurrently. */
export class SubagentBusyError extends Schema.TaggedErrorClass<SubagentBusyError>()('SubagentBusyError', {
	agentId: AgentId,
}) {}

/**
 * The subagent tool's wire parameters did not parse into exactly one command (dispatch by `agent`,
 * resume by `agent_id`, or `fork`). Carries the instructive, model-facing explanation.
 */
export class InvalidSubagentCommandError extends Schema.TaggedErrorClass<InvalidSubagentCommandError>()(
	'InvalidSubagentCommandError',
	{
		message: Schema.String,
	},
) {}
