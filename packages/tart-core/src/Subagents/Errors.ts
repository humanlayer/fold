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

/** No agent with this id has ever been started on the session log. */
export class SubagentNotFoundError extends Schema.TaggedErrorClass<SubagentNotFoundError>()('SubagentNotFoundError', {
	/** The raw id the caller passed (may not even be a well-formed agent id). */
	requested: Schema.String,
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
