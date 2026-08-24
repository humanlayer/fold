/**
 * This file builds the subagent tool (D21) through the public `subagentTool(agents)` factory. The
 * roster IS the factory argument: the returned value's description advertises exactly those types, its
 * closure carries their names as the dispatch authority (`allowedAgents`), and the composition root
 * discovers dispatchable definitions by walking tools arrays for these values (`subagentRosterOf`).
 * The handler is a thin adapter: it parses the flat wire parameters into one `SubagentCommand` at the
 * boundary, delegates to the ambient `Subagents` service, and narrows each typed engine failure into
 * the tool's instructive failure payload with `catchTag`/`catchTags` - all choreography lives in the
 * deep module, and no error is ever inspected as a value.
 */
import { Effect, Match } from 'effect'

import { defineTool, type FoldTool } from '../Api/ToolDefinition'
import type { SkillNotFoundError } from '../Skills/SkillSource'
import { subagentToolContract } from '../Tools/Contracts'
import { shortAgentId } from './AgentIdRef'
import type { SubagentBusyError, SubagentNotFoundError, SubagentTypeNotInRosterError } from './Errors'
import type { ForkAgentDefinition } from './ForkAgentDefinition'
import { parseSubagentCommand, type SubagentResult } from './Schemas'
import type { SubagentDefinition } from './SubagentDefinition'
import { Subagents } from './SubagentsService'

/** Runtime capabilities attached to a model-visible delegation tool. */
export type SubagentToolCapabilities = {
	readonly agents: ReadonlyArray<SubagentDefinition>
	readonly forkAgent?: ForkAgentDefinition
}

const capabilitiesBySubagentTool = new WeakMap<FoldTool, SubagentToolCapabilities>()

/** Attach Fold's roster and fork behavior to any host-defined model-visible tool. */
export const withSubagentCapabilities = (tool: FoldTool, capabilities: SubagentToolCapabilities): FoldTool => {
	capabilitiesBySubagentTool.set(tool, capabilities)
	return tool
}

/** Read the capabilities attached to a delegation tool; null for every other tool. */
export const subagentCapabilitiesOf = (tool: FoldTool): SubagentToolCapabilities | null =>
	capabilitiesBySubagentTool.get(tool) ?? null

/** Read the roster off a subagentTool value; null for every other tool. */
export const subagentRosterOf = (tool: FoldTool): ReadonlyArray<SubagentDefinition> | null =>
	subagentCapabilitiesOf(tool)?.agents ?? null

/** Model-facing failure payload of the subagent tool (schema: message + availableAgents). */
type SubagentToolFailure = {
	readonly message: string
	readonly availableAgents: ReadonlyArray<string>
}

/** Render one subagent result per the D21 template: id + turns header, result body, outcome note. */
export const renderSubagentResult = (result: SubagentResult): string => {
	const header =
		`agent_id: ${shortAgentId(result.agentId)} (pass as agent_id to the subagent tool to resume this agent)\n` +
		`turns: ${result.turnsThisRun} this run (${result.turnsTotal} total)`
	const body = `<subagent_result>\n${result.resultText ?? ''}\n</subagent_result>`
	const note = outcomeNoteFor(result)

	return note === null ? `${header}\n\n${body}` : `${header}\n\n${body}\n${note}`
}

/** The system-information note appended for non-completed outcomes; null for clean completions. */
const outcomeNoteFor = (result: SubagentResult): string | null => {
	switch (result.outcome) {
		case 'completed':
			return null
		case 'error':
			return (
				`<system-information>This subagent finished with an error: ${result.errorMessage ?? 'unknown error'}. ` +
				`Its context is preserved; you may resume it with the agent_id above (it will see your new message), ` +
				`or dispatch a fresh agent.</system-information>`
			)
		case 'stopped':
			return (
				`<system-information>This subagent stopped early (a tool or hook requested a stop). ` +
				`Its context is preserved; you may resume it with the agent_id above.</system-information>`
			)
		case 'interrupted':
			return (
				`<system-information>This subagent was interrupted before completing. ` +
				`Its context is preserved; you may resume it with the agent_id above.</system-information>`
			)
	}
}

// --- pure failure-payload formatters, invoked from catchTag/catchTags branches -----------------------

/** Payload for an out-of-roster (or unknown) agent type. */
const rosterFailure = (error: SubagentTypeNotInRosterError): SubagentToolFailure => ({
	message:
		`Agent type "${error.requested}" is not available to you. Available agent types: ` +
		`${error.availableAgents.length === 0 ? '(none)' : error.availableAgents.join(', ')}.`,
	availableAgents: error.availableAgents,
})

/** Payload for a failed skill preload. */
const skillFailure = (error: SkillNotFoundError, allowedAgents: ReadonlyArray<string>): SubagentToolFailure => ({
	message:
		`Skill "${error.name}" not found. Available skills: ` +
		`${error.availableSkills.length === 0 ? '(none)' : error.availableSkills.join(', ')}.`,
	availableAgents: allowedAgents,
})

/** Payload for a resume reference no agent uniquely matches: unknown, or an ambiguous short prefix. */
const notFoundFailure = (error: SubagentNotFoundError, allowedAgents: ReadonlyArray<string>): SubagentToolFailure => ({
	message:
		error.candidates === undefined || error.candidates.length === 0
			? `No subagent with agent_id "${error.requested}" exists in this session. Use the agent_id from a ` +
				`previous subagent result, or dispatch a fresh agent with the agent parameter.`
			: `agent_id "${error.requested}" is ambiguous: it matches ${error.candidates.length} agents ` +
				`(${[...new Set(error.candidates)].join(', ')}). Provide more characters of the agent_id to ` +
				`identify exactly one.`,
	availableAgents: allowedAgents,
})

/** Payload for resuming an agent that is currently running. */
const busyFailure = (error: SubagentBusyError, allowedAgents: ReadonlyArray<string>): SubagentToolFailure => ({
	message: `Subagent ${shortAgentId(error.agentId)} is currently running and cannot be resumed until it finishes.`,
	availableAgents: allowedAgents,
})

/** Render the roster + usage guidance appended to the contract description for one factory value. */
const rosterDescriptionSuffix = (agents: ReadonlyArray<SubagentDefinition>): string => {
	const listing = agents.map((agent) => `- ${agent.name}: ${agent.description}`).join('\n')

	return (
		`\n\nAvailable agent types:\n${listing}\n\n` +
		`Pass exactly one of: agent (dispatch a fresh subagent of that type), agent_id (resume a previous ` +
		`subagent with its context intact), or fork: true (launch a copy of your own context).`
	)
}

/**
 * Build one subagent tool value over a roster of dispatchable types (round-five public factory). The
 * value is plain data: its description is fixed at construction (cache-stable), its handler reaches the
 * `Subagents` engine as an ambient per-call service, and the composition root reads the roster back off
 * the value (`subagentRosterOf`) to build the session registry. Each call creates an independent value;
 * agents sharing one roster should share one value.
 */
export const subagentTool = (
	agents: ReadonlyArray<SubagentDefinition>,
	options?: { readonly forkAgent?: ForkAgentDefinition },
): FoldTool => {
	const allowedAgents = agents.map((agent) => agent.name)

	const tool = defineTool({
		...subagentToolContract,
		description: `${subagentToolContract.description}${rosterDescriptionSuffix(agents)}`,
		handler: (params) =>
			Effect.gen(function* () {
				const subagents = yield* Subagents
				const command = yield* parseSubagentCommand(params).pipe(
					Effect.catchTag('InvalidSubagentCommandError', (error) =>
						Effect.fail<SubagentToolFailure>({ message: error.message, availableAgents: allowedAgents }),
					),
				)

				return yield* Match.value(command).pipe(
					Match.tagsExhaustive({
						dispatch: (dispatchCommand) =>
							subagents
								.dispatch({
									agent: dispatchCommand.agent,
									prompt: dispatchCommand.prompt,
									skill: dispatchCommand.skill,
									allowedAgents,
								})
								.pipe(
									Effect.catchTags({
										SubagentTypeNotInRosterError: (error) => Effect.fail(rosterFailure(error)),
										SkillNotFoundError: (error) => Effect.fail(skillFailure(error, allowedAgents)),
									}),
									Effect.map((result) => ({ content: renderSubagentResult(result) })),
								),
						fork: (forkCommand) =>
							subagents
								.fork({
									prompt: forkCommand.prompt,
									skill: forkCommand.skill,
									forkAgentDefinitionId: options?.forkAgent?.id ?? null,
								})
								.pipe(
									Effect.catchTag('SkillNotFoundError', (error) =>
										Effect.fail(skillFailure(error, allowedAgents)),
									),
									Effect.map((result) => ({ content: renderSubagentResult(result) })),
								),
						resume: (resumeCommand) =>
							subagents
								.resume({
									agentId: resumeCommand.agentId,
									prompt: resumeCommand.prompt,
									skill: resumeCommand.skill,
								})
								.pipe(
									Effect.catchTags({
										SubagentNotFoundError: (error) =>
											Effect.fail(notFoundFailure(error, allowedAgents)),
										SubagentBusyError: (error) => Effect.fail(busyFailure(error, allowedAgents)),
										SkillNotFoundError: (error) => Effect.fail(skillFailure(error, allowedAgents)),
									}),
									Effect.map((result) => ({ content: renderSubagentResult(result) })),
								),
					}),
				)
			}),
	})

	return withSubagentCapabilities(tool, { agents, ...(options?.forkAgent === undefined ? {} : options) })
}
