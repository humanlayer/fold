/**
 * This file builds the model-facing controls over background agents: `list_agents`, `stop_agent`, and
 * `send_message`. Install them next to a `subagentTool` value (`agentControlTools()` returns all
 * three). They are thin adapters over the session's BackgroundTasks registry, its run controls, and
 * the subagent operations: listing reads the registry, stopping interrupts one run (silently - the
 * caller already knows), and messaging steers a running agent or resumes a finished one in the
 * background. Every expected failure comes back to the model as an instructive tool failure.
 */
import { Array as Arr, Effect, Match, Predicate, Stream } from 'effect'

import { defineTool, type FoldTool } from '../Api/ToolDefinition'
import { EventLog } from '../EventLog/EventLogService'
import type { LogEntry } from '../EventLog/Schemas'
import type { AgentId } from '../Ids'
import { SessionControls } from '../Session/SessionControls'
import { CurrentAgent } from '../ToolRuntime/ToolContextServices'
import { listAgentsToolContract, sendMessageToolContract, stopAgentToolContract } from '../Tools/Contracts'
import { ToolResultFailure, ToolResultText } from '../Tools/ToolResultContent'
import { agentIdsFromEntries, resolveAgentIdRef, shortAgentId } from './AgentIdRef'
import { BackgroundTasks, type BackgroundTask } from './BackgroundTasks'
import { resumeSubagentInBackground } from './SubagentEngine'
import { renderBackgroundLaunch } from './SubagentTool'

const RESULT_PREVIEW_LENGTH = 300

const preview = (text: string): string => {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length <= RESULT_PREVIEW_LENGTH ? flat : `${flat.slice(0, RESULT_PREVIEW_LENGTH)}...`
}

/** One list_agents line (plus an indented detail line) for a task. */
const renderTaskLine = (task: BackgroundTask): string => {
	const label = task.agentType ?? 'fork'
	const work = `${task.usage.turns} turn${task.usage.turns === 1 ? '' : 's'}, ${task.usage.toolUses} tool use${task.usage.toolUses === 1 ? '' : 's'}`
	const head = `- ${shortAgentId(task.taskId)} [${task.status}] ${label}: "${task.description}" (${work})`
	const detail = Match.value(task.status).pipe(
		Match.when('running', () => (task.lastToolName === null ? null : `  last tool: ${task.lastToolName}`)),
		Match.when('failed', () => (task.error === null ? null : `  error: ${preview(task.error)}`)),
		Match.orElse(() => (task.summary === null ? null : `  result: ${preview(task.summary)}`)),
	)
	return detail === null ? head : `${head}\n${detail}`
}

/** Render the whole registry for the model: running tasks first, then finished ones. */
export const renderAgentList = (tasks: ReadonlyArray<BackgroundTask>): string => {
	if (Arr.isReadonlyArrayEmpty(tasks)) return 'No background agents in this session.'
	const running = tasks.filter((task) => task.status === 'running')
	const finished = tasks.filter((task) => task.status !== 'running')
	return [
		`Background agents: ${running.length} running, ${finished.length} finished.`,
		...running.map(renderTaskLine),
		...finished.map(renderTaskLine),
	].join('\n')
}

const collectEntries: Effect.Effect<ReadonlyArray<LogEntry>, never, EventLog> = EventLog.use((eventLog) =>
	Stream.runCollect(eventLog.entries()),
).pipe(
	Effect.orDie,
	Effect.map((entries): ReadonlyArray<LogEntry> => entries),
)

const unknownAgent = (ref: string, candidates?: ReadonlyArray<string>): ToolResultFailure =>
	ToolResultFailure.make({
		text:
			candidates === undefined
				? `No agent with agent_id "${ref}" exists in this session. Use list_agents to see the agent ids.`
				: `agent_id "${ref}" is ambiguous: it matches ${candidates.length} agents ` +
					`(${[...new Set(candidates)].join(', ')}). Provide more characters of the agent_id.`,
	})

/** Resolve a model-supplied reference against a set of known agent ids, as a tool failure when it does not match. */
const resolveRef = (known: Iterable<AgentId>, ref: string): Effect.Effect<AgentId, ToolResultFailure> =>
	Match.valueTags(resolveAgentIdRef(known, ref), {
		resolved: ({ agentId }) => Effect.succeed(agentId),
		'not-found': () => Effect.fail(unknownAgent(ref)),
		ambiguous: ({ candidates }) => Effect.fail(unknownAgent(ref, candidates)),
	})

/** True when `target` is the caller itself or one of the caller's running ancestors. */
const isSelfOrAncestor = (entries: ReadonlyArray<LogEntry>, caller: AgentId, target: AgentId): boolean => {
	let current: AgentId | null = caller
	const seen = new Set<AgentId>()
	while (current !== null && !seen.has(current)) {
		if (current === target) return true
		seen.add(current)
		const id: AgentId = current
		const started = entries.find((entry) => Predicate.isTagged(entry, 'agent_started') && entry.agentId === id)
		current = started === undefined ? null : started.parentAgentId
	}
	return false
}

/** list_agents: the registry, rendered. */
export const listAgentsTool = (): FoldTool =>
	defineTool({
		...listAgentsToolContract,
		handler: () =>
			BackgroundTasks.use((tasks) => tasks.list).pipe(
				Effect.map((tasks) => ToolResultText.make({ text: renderAgentList(tasks) })),
			),
	})

/** stop_agent: interrupt one running background task. The caller asked, so no notification follows. */
export const stopAgentTool = (): FoldTool =>
	defineTool({
		...stopAgentToolContract,
		handler: ({ agent_id }) =>
			Effect.gen(function* () {
				const tasks = yield* BackgroundTasks
				const known = (yield* tasks.list).map((task) => task.taskId)
				const taskId = yield* resolveRef(known, agent_id)
				const stopped = yield* tasks.stop(taskId, 'silent')
				if (!stopped) {
					const task = yield* tasks.get(taskId)
					return yield* Effect.fail(
						ToolResultFailure.make({
							text: `Agent ${shortAgentId(taskId)} is not running (status: ${task?.status ?? 'unknown'}).`,
						}),
					)
				}
				return ToolResultText.make({
					text:
						`Stopped background agent ${shortAgentId(taskId)}. Its work so far is kept; send_message ` +
						`with this agent_id continues it.`,
				})
			}),
	})

/** send_message: steer a running subagent, or continue a finished one as a background task. */
export const sendMessageTool = (): FoldTool =>
	defineTool({
		...sendMessageToolContract,
		handler: ({ agent_id, message }) =>
			Effect.gen(function* () {
				const tasks = yield* BackgroundTasks
				const controls = yield* SessionControls
				const caller = yield* CurrentAgent
				const entries = yield* collectEntries
				const target = yield* resolveRef(agentIdsFromEntries(entries), agent_id)

				if (isSelfOrAncestor(entries, caller.agentId, target)) {
					return yield* Effect.fail(
						ToolResultFailure.make({
							text: `Agent ${shortAgentId(target)} is you or an agent waiting on you; it cannot be messaged.`,
						}),
					)
				}

				const steerRunning = controls.steer(target, message).pipe(
					Effect.as(
						ToolResultText.make({
							text:
								`Message queued for running agent ${shortAgentId(target)}; it reads it after its ` +
								`current step.`,
						}),
					),
				)
				const steered = yield* steerRunning.pipe(
					Effect.catchTag('AgentNotRunningError', () => Effect.succeed(null)),
				)
				if (steered !== null) return steered

				// A run that just ended may still be releasing the agent; wait for that before resuming it.
				yield* tasks.awaitSettled(target)
				return yield* resumeSubagentInBackground({ agentId: target, prompt: message, skill: null }).pipe(
					Effect.map((task) => ToolResultText.make({ text: renderBackgroundLaunch(task) })),
					Effect.catchTags({
						SubagentNotFoundError: () => Effect.fail(unknownAgent(agent_id)),
						SubagentBusyError: () =>
							Effect.fail(
								ToolResultFailure.make({
									text: `Agent ${shortAgentId(target)} is busy right now. Try again after its current run ends.`,
								}),
							),
						SkillNotFoundError: (error) =>
							Effect.fail(ToolResultFailure.make({ text: `Skill "${error.name}" not found.` })),
					}),
				)
			}),
	})

/** The three background-agent controls, for installing next to a `subagentTool` value. */
export const agentControlTools = (): ReadonlyArray<FoldTool> => [listAgentsTool(), stopAgentTool(), sendMessageTool()]
