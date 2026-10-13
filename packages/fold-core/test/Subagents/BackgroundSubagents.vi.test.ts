/**
 * Background subagents end to end through the public facade: the real `subagent` tool with
 * `run_in_background`, the model-facing controls, and the session handle. Scripted models with gated
 * turns decide when each agent finishes, so every ordering below is deterministic: the launch returns
 * at once and the root's turn completes while the child runs; an idle root is woken by a synthetic
 * task-notification turn; a busy root gets completions as one coalesced follow-up; stopTask, interrupt,
 * stop, and session close each end background work the documented way.
 */
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Predicate, Stream } from 'effect'

import {
	agentControlTools,
	defineAgent,
	defineSubagent,
	EventLog,
	layerInMemoryEventLogWithIds,
	layerLiveIdFactory,
	LogEntryInputs,
	Session,
	shortAgentId,
	subagentTool,
	type BackgroundTask,
	type FoldModel,
	type LogEntry,
} from '../../src/index'
import { claudeActiveModel, gptActiveModel } from '../Api/ApiTestHelpers'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import {
	awaitTasks,
	gatedTurn,
	makeGatedModel,
	messageText,
	notificationMessages,
	rootFinishedOutcomes,
	taskFinishedRows,
	taskStartedRows,
	toolResultTexts,
} from './BackgroundHarness'

const backgroundCall = (id: string, description: string, prompt = 'dig into it') =>
	({
		id,
		name: 'subagent',
		params: { agent: 'researcher', description, prompt, run_in_background: true },
	}) as const

const openBackgroundSession = (rootModel: FoldModel, childModel: FoldModel) => {
	const researcher = defineSubagent({
		name: 'researcher',
		description: 'explores',
		systemPrompt: 'You are a researcher.',
		model: childModel,
	})
	return Session.open({
		agent: defineAgent({
			model: rootModel,
			systemPrompt: 'root',
			tools: [subagentTool([researcher]), ...agentControlTools()],
		}),
	})
}

/** The outcome of an agent's latest agent-finished row, or null when it has none. */
const lastOutcome = (entries: ReadonlyArray<LogEntry>, agentId: string): string | null =>
	entries
		.flatMap((entry) =>
			Predicate.isTagged(entry, 'agent-finished') && entry.agentId === agentId ? [entry.outcome] : [],
		)
		.at(-1) ?? null

const onlyTask = (tasks: ReadonlyArray<BackgroundTask>): BackgroundTask => {
	const task = tasks[0]
	if (task === undefined || tasks.length !== 1) throw new Error(`expected exactly one task, got ${tasks.length}`)
	return task
}

it.effect('a background launch returns at once, and the idle root is woken by a task notification', () =>
	Effect.gen(function* () {
		const release = yield* Deferred.make<void>()
		const child = yield* makeGatedModel(claudeActiveModel, [
			gatedTurn(textTurn('found the config loader'), { gate: release }),
		])
		const root = yield* makeGatedModel(gptActiveModel, [
			toolCallTurn([backgroundCall('provider-call-1', 'find the config loader')]),
			textTurn('I started a researcher.'),
			textTurn('The researcher found the config loader.'),
		])
		const session = yield* openBackgroundSession(root.model, child.model)

		// The root's turn completes while the child is still blocked on its first model call.
		const finished = yield* session.send('where is the config loaded?')
		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('I started a researcher.')

		const running = onlyTask(yield* session.backgroundTasks)
		expect(running.status).toBe('running')
		expect(running.description).toBe('find the config loader')
		expect(running.agentType).toBe('researcher')
		expect(running.prompt).toBe('dig into it')
		expect(running.runCount).toBe(1)

		const launched = yield* session.entries
		expect(toolResultTexts(launched)[0]).toContain(
			`Background agent started. agent_id: ${shortAgentId(running.taskId)}`,
		)
		const started = taskStartedRows(launched)
		expect(started).toHaveLength(1)
		expect(started[0]?.isBackgrounded).toBe(true)
		expect(started[0]?.parentAgentId).toBe(session.rootAgentId)
		// task_started lands after the child's own start rows and before its first message.
		const childTags = launched.filter((entry) => entry.agentId === running.taskId).map((entry) => entry._tag)
		expect(childTags).toEqual(['agent_started', 'system-message', 'task_started', 'user-message'])

		yield* Deferred.succeed(release, undefined)
		yield* session.awaitBackgroundIdle

		const entries = yield* session.entries
		const taskFinished = taskFinishedRows(entries)
		expect(taskFinished).toHaveLength(1)
		expect(taskFinished[0]?.status).toBe('completed')
		expect(taskFinished[0]?.summary).toBe('found the config loader')
		expect(taskFinished[0]?.usage).toEqual({ turns: 1, toolUses: 0, totalTokens: 15 })

		// The wake: a synthetic root user message carrying the notification, then a root run on it.
		const notifications = notificationMessages(entries)
		expect(notifications).toHaveLength(1)
		const notification = notifications[0]
		if (notification === undefined) throw new Error('expected a notification')
		expect(notification.agentId).toBe(session.rootAgentId)
		expect(notification.origin).toEqual({ _tag: 'task-notification', taskIds: [running.taskId] })
		expect(messageText(notification)).toContain('<task-notification>')
		expect(messageText(notification)).toContain('<status>completed</status>')
		expect(messageText(notification)).toContain('found the config loader')

		const rootRuns = rootFinishedOutcomes(entries, session.rootAgentId)
		expect(rootRuns.map((run) => run.resultText)).toEqual([
			'I started a researcher.',
			'The researcher found the config loader.',
		])

		const done = onlyTask(yield* session.backgroundTasks)
		expect(done.status).toBe('completed')
		expect(done.summary).toBe('found the config loader')
		expect(done.notifiedAt).not.toBeNull()
		expect(done.endedAt).not.toBeNull()
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)

it.effect('completions during a busy root arrive as one coalesced follow-up, without a separate wake', () =>
	Effect.gen(function* () {
		const rootGate = yield* Deferred.make<void>()
		const child = yield* makeGatedModel(claudeActiveModel, [textTurn('first result'), textTurn('second result')])
		const root = yield* makeGatedModel(gptActiveModel, [
			toolCallTurn([
				backgroundCall('provider-call-1', 'task one'),
				backgroundCall('provider-call-2', 'task two'),
			]),
			gatedTurn(textTurn('both launched'), { gate: rootGate }),
			textTurn('handled both results'),
		])
		const session = yield* openBackgroundSession(root.model, child.model)

		const sendFiber = yield* Effect.forkScoped(session.send('do two things'))
		// Both children finish (and are handed to the running root) while the root's turn is held.
		yield* awaitTasks(
			session,
			(tasks) =>
				tasks.length === 2 && tasks.every((task) => task.status === 'completed' && task.notifiedAt !== null),
		)
		yield* Deferred.succeed(rootGate, undefined)

		const finished = yield* Fiber.join(sendFiber)
		expect(finished.resultText).toBe('handled both results')
		yield* session.awaitBackgroundIdle

		const entries = yield* session.entries
		const notifications = notificationMessages(entries)
		expect(notifications).toHaveLength(1)
		const taskIds = (yield* session.backgroundTasks).map((task) => task.taskId)
		expect(notifications[0]?.origin?.taskIds).toHaveLength(2)
		expect([...(notifications[0]?.origin?.taskIds ?? [])].sort()).toEqual([...taskIds].sort())
		const text = notifications[0] === undefined ? '' : messageText(notifications[0])
		expect(text.match(/<task-notification>/g)).toHaveLength(2)
		// One root run consumed everything: no extra wake.
		expect(rootFinishedOutcomes(entries, session.rootAgentId)).toHaveLength(1)
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)

it.effect('stopTask ends one background run as stopped and notifies the root', () =>
	Effect.gen(function* () {
		const hang = yield* Deferred.make<void>()
		const child = yield* makeGatedModel(claudeActiveModel, [gatedTurn(textTurn('never'), { gate: hang })])
		const root = yield* makeGatedModel(gptActiveModel, [
			toolCallTurn([backgroundCall('provider-call-1', 'long job')]),
			textTurn('launched'),
			textTurn('noted that it was stopped'),
		])
		const session = yield* openBackgroundSession(root.model, child.model)
		yield* session.send('start a long job')
		const task = onlyTask(yield* session.backgroundTasks)

		expect(yield* session.stopTask(shortAgentId(task.taskId))).toBe(true)
		expect(yield* session.stopTask(task.taskId)).toBe(false)
		yield* session.awaitBackgroundIdle

		const entries = yield* session.entries
		expect(taskFinishedRows(entries).map((row) => row.status)).toEqual(['stopped'])
		expect(lastOutcome(entries, task.taskId)).toBe('interrupted')
		const notifications = notificationMessages(entries)
		expect(notifications).toHaveLength(1)
		expect(notifications[0] === undefined ? '' : messageText(notifications[0])).toContain(
			'<status>stopped</status>',
		)
		expect(rootFinishedOutcomes(entries, session.rootAgentId).at(-1)?.resultText).toBe('noted that it was stopped')
		expect(onlyTask(yield* session.backgroundTasks).status).toBe('stopped')
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)

it.effect('interrupt() stops only the root turn; background tasks keep running and still notify', () =>
	Effect.gen(function* () {
		const childGate = yield* Deferred.make<void>()
		const rootHang = yield* Deferred.make<void>()
		const rootHangStarted = yield* Deferred.make<void>()
		const child = yield* makeGatedModel(claudeActiveModel, [
			gatedTurn(textTurn('child result'), { gate: childGate }),
		])
		const root = yield* makeGatedModel(gptActiveModel, [
			toolCallTurn([backgroundCall('provider-call-1', 'survivor')]),
			gatedTurn(textTurn('never'), { gate: rootHang, started: rootHangStarted }),
			textTurn('relayed after interrupt'),
		])
		const session = yield* openBackgroundSession(root.model, child.model)

		const sendFiber = yield* Effect.forkScoped(session.send('go'))
		yield* Deferred.await(rootHangStarted)
		yield* session.interrupt()
		const interrupted = yield* Fiber.join(sendFiber)
		expect(interrupted.outcome).toBe('interrupted')
		expect(onlyTask(yield* session.backgroundTasks).status).toBe('running')

		yield* Deferred.succeed(childGate, undefined)
		yield* session.awaitBackgroundIdle

		const entries = yield* session.entries
		expect(taskFinishedRows(entries).map((row) => row.status)).toEqual(['completed'])
		expect(rootFinishedOutcomes(entries, session.rootAgentId).map((run) => run.outcome)).toEqual([
			'interrupted',
			'completed',
		])
		expect(notificationMessages(entries)).toHaveLength(1)
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)

it.effect('stop() stops background tasks without waking the root; the next run hears about them first', () =>
	Effect.gen(function* () {
		const hang = yield* Deferred.make<void>()
		const child = yield* makeGatedModel(claudeActiveModel, [gatedTurn(textTurn('never'), { gate: hang })])
		const root = yield* makeGatedModel(gptActiveModel, [
			toolCallTurn([backgroundCall('provider-call-1', 'stoppable')]),
			textTurn('launched'),
			textTurn('next reply'),
		])
		const session = yield* openBackgroundSession(root.model, child.model)
		yield* session.send('go')

		yield* session.stop()
		yield* session.awaitBackgroundIdle
		const afterStop = yield* session.entries
		expect(taskFinishedRows(afterStop).map((row) => row.status)).toEqual(['stopped'])
		expect(notificationMessages(afterStop)).toHaveLength(0)
		expect(rootFinishedOutcomes(afterStop, session.rootAgentId)).toHaveLength(1)

		// The held notification is steered into the next root run, ahead of its first model call.
		const next = yield* session.send('what happened?')
		expect(next.resultText).toBe('next reply')
		const entries = yield* session.entries
		const notifications = notificationMessages(entries)
		expect(notifications).toHaveLength(1)
		const userTexts = entries.flatMap((entry) =>
			Predicate.isTagged(entry, 'user-message') && entry.agentId === session.rootAgentId
				? [messageText(entry)]
				: [],
		)
		expect(userTexts.at(-2)).toBe('what happened?')
		expect(userTexts.at(-1)).toContain('<status>stopped</status>')
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)

it.effect('closing the session stops background tasks durably; reopening rebuilds the registry', () =>
	Effect.gen(function* () {
		const hang = yield* Deferred.make<void>()
		const child = yield* makeGatedModel(claudeActiveModel, [gatedTurn(textTurn('never'), { gate: hang })])
		const root = yield* makeGatedModel(gptActiveModel, [
			toolCallTurn([backgroundCall('provider-call-1', 'outlived')]),
			textTurn('launched'),
		])
		const eventLog = yield* EventLog

		const taskId = yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* openBackgroundSession(root.model, child.model)
				yield* session.send('go')
				return onlyTask(yield* session.backgroundTasks).taskId
			}),
		)

		const closed = yield* Stream.runCollect(eventLog.entries()).pipe(Effect.orDie)
		expect(taskFinishedRows(closed).map((row) => [row.agentId, row.status])).toEqual([[taskId, 'stopped']])
		expect(lastOutcome(closed, taskId)).toBe('interrupted')

		// A run a crashed process left open: task_started with no task_finished.
		const firstRun = taskStartedRows(closed)[0]
		if (firstRun === undefined) throw new Error('expected the first task_started row')
		yield* eventLog
			.append(
				LogEntryInputs.task_started({
					agentId: taskId,
					parentAgentId: firstRun.parentAgentId,
					toolCallId: firstRun.toolCallId,
					taskType: 'subagent',
					agentType: 'researcher',
					description: 'orphaned run',
					prompt: 'again',
					isBackgrounded: true,
					runCount: 2,
				}),
			)
			.pipe(Effect.orDie)

		const reopened = yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* openBackgroundSession(root.model, child.model)
				return yield* session.backgroundTasks
			}),
		)
		const task = onlyTask(reopened)
		expect(task.taskId).toBe(taskId)
		expect(task.status).toBe('stopped')
		expect(task.runCount).toBe(2)
		expect(task.error).toContain('session ended')
		const after = yield* Stream.runCollect(eventLog.entries()).pipe(Effect.orDie)
		expect(taskFinishedRows(after)).toHaveLength(2)
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Layer.mergeAll(NodeFileSystem.layer, layerInMemoryEventLogWithIds.pipe(Layer.provide(layerLiveIdFactory))),
		),
	),
)

it.effect('list_agents, send_message, and stop_agent drive background agents from the model', () =>
	Effect.gen(function* () {
		const firstRequestStarted = yield* Deferred.make<void>()
		const hang = yield* Deferred.make<void>()
		const child = yield* makeGatedModel(claudeActiveModel, [
			gatedTurn(textTurn('never'), { gate: hang, started: firstRequestStarted }),
			textTurn('resumed answer'),
		])
		const root = yield* makeGatedModel(gptActiveModel, [
			toolCallTurn([backgroundCall('provider-call-1', 'controlled')]),
			textTurn('launched'),
		])
		const session = yield* openBackgroundSession(root.model, child.model)
		yield* session.send('go')
		yield* Deferred.await(firstRequestStarted)
		const task = onlyTask(yield* session.backgroundTasks)
		const ref = shortAgentId(task.taskId)

		yield* root.push([
			toolCallTurn([{ id: 'provider-call-2', name: 'list_agents', params: {} }]),
			toolCallTurn([
				{ id: 'provider-call-3', name: 'send_message', params: { agent_id: ref, message: 'also check X' } },
			]),
			toolCallTurn([{ id: 'provider-call-4', name: 'stop_agent', params: { agent_id: ref } }]),
			toolCallTurn([{ id: 'provider-call-5', name: 'stop_agent', params: { agent_id: ref } }]),
			textTurn('managed'),
		])
		const managed = yield* session.send('manage it')
		expect(managed.resultText).toBe('managed')
		yield* session.awaitBackgroundIdle

		const afterManage = yield* session.entries
		const results = toolResultTexts(afterManage)
		expect(results[1]).toContain('1 running, 0 finished')
		expect(results[1]).toContain(`${ref} [running] researcher: \\"controlled\\"`)
		expect(results[2]).toContain('Message queued for running agent')
		expect(results[3]).toContain(`Stopped background agent ${ref}`)
		expect(results[4]).toContain('is not running (status: stopped)')
		// The model stopped it itself: no notification, no wake.
		expect(notificationMessages(afterManage)).toHaveLength(0)
		expect(rootFinishedOutcomes(afterManage, session.rootAgentId)).toHaveLength(2)

		// Messaging a stopped agent continues it in the background; its completion wakes the root.
		yield* root.push([
			toolCallTurn([
				{ id: 'provider-call-6', name: 'send_message', params: { agent_id: ref, message: 'resume please' } },
			]),
			textTurn('resumed it'),
			textTurn('got the resumed answer'),
		])
		yield* session.send('continue it')
		yield* session.awaitBackgroundIdle

		const entries = yield* session.entries
		expect(toolResultTexts(entries)[5]).toContain(`Background agent resumed. agent_id: ${ref}`)
		const runs = taskStartedRows(entries)
		expect(runs.map((row) => row.runCount)).toEqual([1, 2])
		expect(runs[1]?.prompt).toBe('resume please')
		expect(runs[1]?.description).toBe('controlled')
		expect(taskFinishedRows(entries).map((row) => row.status)).toEqual(['stopped', 'completed'])
		const resumed = onlyTask(yield* session.backgroundTasks)
		expect(resumed.status).toBe('completed')
		expect(resumed.summary).toBe('resumed answer')
		expect(resumed.runCount).toBe(2)
		expect(rootFinishedOutcomes(entries, session.rootAgentId).at(-1)?.resultText).toBe('got the resumed answer')
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)

const openNestedSession = (rootModel: FoldModel, coordinatorModel: FoldModel, researcherModel: FoldModel) => {
	const researcher = defineSubagent({
		name: 'researcher',
		description: 'explores',
		systemPrompt: 'You are a researcher.',
		model: researcherModel,
	})
	const coordinator = defineSubagent({
		name: 'coordinator',
		description: 'delegates',
		systemPrompt: 'You coordinate.',
		model: coordinatorModel,
		tools: [subagentTool([researcher])],
	})
	return Session.open({
		agent: defineAgent({ model: rootModel, systemPrompt: 'root', tools: [subagentTool([coordinator])] }),
	})
}

const coordinatorCall = {
	id: 'provider-call-root',
	name: 'subagent',
	params: { agent: 'coordinator', prompt: 'coordinate' },
} as const

it.effect('a background task launched by a running subagent notifies that subagent', () =>
	Effect.gen(function* () {
		const coordinatorGate = yield* Deferred.make<void>()
		const researcher = yield* makeGatedModel(claudeActiveModel, [textTurn('grandchild result')])
		const coordinator = yield* makeGatedModel(claudeActiveModel, [
			toolCallTurn([backgroundCall('provider-call-c1', 'nested task')]),
			gatedTurn(textTurn('waiting on it'), { gate: coordinatorGate }),
			textTurn('coordinator saw the result'),
		])
		const root = yield* makeGatedModel(gptActiveModel, [toolCallTurn([coordinatorCall]), textTurn('root done')])
		const session = yield* openNestedSession(root.model, coordinator.model, researcher.model)

		const sendFiber = yield* Effect.forkScoped(session.send('go'))
		yield* awaitTasks(session, (tasks) => tasks.length === 1 && tasks.every((task) => task.notifiedAt !== null))
		yield* Deferred.succeed(coordinatorGate, undefined)
		const finished = yield* Fiber.join(sendFiber)
		expect(finished.resultText).toBe('root done')
		yield* session.awaitBackgroundIdle

		const entries = yield* session.entries
		const task = onlyTask(yield* session.backgroundTasks)
		const notifications = notificationMessages(entries)
		expect(notifications).toHaveLength(1)
		expect(notifications[0]?.agentId).toBe(task.parentAgentId)
		expect(notifications[0]?.agentId).not.toBe(session.rootAgentId)
		expect(rootFinishedOutcomes(entries, session.rootAgentId)).toHaveLength(1)
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)

it.effect('a background task whose launcher already finished notifies the root', () =>
	Effect.gen(function* () {
		const release = yield* Deferred.make<void>()
		const researcher = yield* makeGatedModel(claudeActiveModel, [
			gatedTurn(textTurn('late result'), { gate: release }),
		])
		const coordinator = yield* makeGatedModel(claudeActiveModel, [
			toolCallTurn([backgroundCall('provider-call-c1', 'outlives its launcher')]),
			textTurn('coordinator done'),
		])
		const root = yield* makeGatedModel(gptActiveModel, [
			toolCallTurn([coordinatorCall]),
			textTurn('root done'),
			textTurn('root relayed the late result'),
		])
		const session = yield* openNestedSession(root.model, coordinator.model, researcher.model)

		yield* session.send('go')
		yield* Deferred.succeed(release, undefined)
		yield* session.awaitBackgroundIdle

		const entries = yield* session.entries
		const notifications = notificationMessages(entries)
		expect(notifications).toHaveLength(1)
		expect(notifications[0]?.agentId).toBe(session.rootAgentId)
		expect(rootFinishedOutcomes(entries, session.rootAgentId).map((run) => run.resultText)).toEqual([
			'root done',
			'root relayed the late result',
		])
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)
