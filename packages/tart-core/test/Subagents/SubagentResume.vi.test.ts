/**
 * Engine tests for subagent resume (D21): a previously dispatched subagent - completed, errored, or
 * dead from a defect - is resumable by agent_id with its full prior context, new rows grouping under
 * the RESUMING tool call. The root drives the engine through a test-only `drive` tool whose handler
 * yields the ambient Subagents service directly, so resume ids (only known after the first dispatch)
 * can be chosen at runtime while everything else - facade, provisioning, per-call ambient services,
 * the child loops - is real.
 */
import { expect, it } from '@effect/vitest'
import { Effect, Ref, Schema } from 'effect'

import {
	defineAgent,
	defineSubagent,
	defineTool,
	renderSubagentResult,
	startSession,
	Subagents,
	subagentTool,
	type AgentId,
	type AgentStartedLogEntry,
	type LogEntry,
	type SubagentDefinition,
	type UserMessageLogEntry,
} from '../../src/index'
import { claudeActiveModel, gptActiveModel, scriptedModel } from '../Api/ApiTestHelpers'
import { failureTurn, textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'

/** One engine operation the drive tool should perform on its next invocation. */
type DriveInstruction =
	| { readonly op: 'dispatch'; readonly agent: string; readonly prompt: string }
	| { readonly op: 'resume'; readonly agentId: AgentId; readonly prompt: string }

/** A test-only tool whose handler drives the ambient Subagents engine from a mutable instruction slot. */
const makeDriveTool = (instructions: Ref.Ref<ReadonlyArray<DriveInstruction>>, roster: ReadonlyArray<string>) =>
	defineTool({
		name: 'drive',
		description: 'Test driver over the Subagents engine.',
		parameters: Schema.Struct({}),
		success: Schema.Struct({ content: Schema.String }),
		failure: Schema.Struct({ message: Schema.String }),
		handler: () =>
			Effect.gen(function* () {
				const remaining = yield* Ref.get(instructions)
				const instruction = remaining[0]
				if (instruction === undefined) {
					return yield* Effect.die(new Error('drive tool invoked with no instruction queued'))
				}
				yield* Ref.set(instructions, remaining.slice(1))

				const subagents = yield* Subagents
				const result =
					instruction.op === 'dispatch'
						? yield* subagents
								.dispatch({
									agent: instruction.agent,
									prompt: instruction.prompt,
									skill: null,
									allowedAgents: roster,
								})
								.pipe(Effect.mapError((error) => ({ message: `dispatch failed: ${error._tag}` })))
						: yield* subagents
								.resume({ agentId: instruction.agentId, prompt: instruction.prompt, skill: null })
								.pipe(Effect.mapError((error) => ({ message: `resume failed: ${error._tag}` })))

				return { content: renderSubagentResult(result) }
			}),
	})

/** Harness: a session whose root calls `drive` once per send, with instructions swappable between sends. */
const makeDriveSession = (input: {
	readonly definitions: ReadonlyArray<SubagentDefinition>
	readonly rootTurns: number
}) =>
	Effect.gen(function* () {
		const instructions = yield* Ref.make<ReadonlyArray<DriveInstruction>>([])
		const roster = input.definitions.map((definition) => definition.name)

		const rootScripted = yield* scriptedModel(
			gptActiveModel,
			Array.from({ length: input.rootTurns }, (_, index) => [
				toolCallTurn([{ id: `provider-call-${index}`, name: 'drive', params: {} }]),
				textTurn(`root-done-${index}`),
			]).flat(),
		)

		const session = yield* startSession({
			agent: defineAgent({
				model: rootScripted.model,
				systemPrompt: 'root',
				tools: [makeDriveTool(instructions, roster), subagentTool(input.definitions)],
			}),
		})

		const drive = (instruction: DriveInstruction) =>
			Effect.gen(function* () {
				yield* Ref.set(instructions, [instruction])
				return yield* session.send('next')
			})

		return { session, drive }
	})

const subagentStartedEntries = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<AgentStartedLogEntry> =>
	entries.filter(
		(entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started' && entry.parentAgentId !== null,
	)

const renderedDriveResult = (entries: ReadonlyArray<LogEntry>, occurrence: number): string => {
	const results = entries.filter((entry) => entry._tag === 'tool-result')
	const entry = results[occurrence]
	if (entry === undefined || entry._tag !== 'tool-result') throw new Error('expected a tool-result entry')
	return JSON.stringify(entry.message.content[0])
}

it.effect('resumes a completed subagent: no new agent_started, rows under the resuming call, full history', () =>
	Effect.gen(function* () {
		const researcherScripted = yield* scriptedModel(claudeActiveModel, [
			textTurn('first findings'),
			textTurn('resumed findings'),
		])
		const researcher = defineSubagent({
			name: 'researcher',
			description: 'explores',
			systemPrompt: 'You are a researcher.',
			model: researcherScripted.model,
		})

		const { session, drive } = yield* makeDriveSession({ definitions: [researcher], rootTurns: 2 })

		yield* drive({ op: 'dispatch', agent: 'researcher', prompt: 'first task' })
		const afterDispatch = yield* session.entries
		const started = subagentStartedEntries(afterDispatch)[0]
		if (started === undefined) throw new Error('expected the dispatched subagent to have started')

		yield* drive({ op: 'resume', agentId: started.agentId, prompt: 'keep going' })
		const entries = yield* session.entries

		// Resume writes no second agent_started for the subagent.
		expect(subagentStartedEntries(entries)).toHaveLength(1)

		// The resumed run's rows group under the RESUMING tool call (per-dispatch envelope, D2).
		const subagentUserMessages = entries.filter(
			(entry): entry is UserMessageLogEntry => entry._tag === 'user-message' && entry.agentId === started.agentId,
		)
		expect(subagentUserMessages).toHaveLength(2)
		const dispatchCall = subagentUserMessages[0]?.toolCallId
		const resumeCall = subagentUserMessages[1]?.toolCallId
		expect(dispatchCall).not.toBeNull()
		expect(resumeCall).not.toBeNull()
		expect(resumeCall).not.toBe(dispatchCall)

		// The resumed model call saw the full prior history plus the new prompt.
		const prompts = yield* researcherScripted.scripted.prompts
		const resumedPrompt = JSON.stringify(prompts[1])
		expect(resumedPrompt).toContain('first task')
		expect(resumedPrompt).toContain('first findings')
		expect(resumedPrompt).toContain('keep going')

		// The resumed result reports per-run and lifetime turns.
		const rendered = renderedDriveResult(entries, 1)
		expect(rendered).toContain(`agent_id: ${started.agentId}`)
		expect(rendered).toContain('turns: 1 this run (2 total)')
		expect(rendered).toContain('resumed findings')
	}).pipe(Effect.scoped),
)

it.effect('a subagent that errored is a result and remains resumable (model failure path)', () =>
	Effect.gen(function* () {
		const flakyScripted = yield* scriptedModel(claudeActiveModel, [
			failureTurn('provider exploded'),
			textTurn('recovered'),
		])
		const flaky = defineSubagent({
			name: 'flaky',
			description: 'fails once',
			model: flakyScripted.model,
		})

		const { session, drive } = yield* makeDriveSession({ definitions: [flaky], rootTurns: 2 })

		const firstFinished = yield* drive({ op: 'dispatch', agent: 'flaky', prompt: 'try it' })
		expect(firstFinished.outcome).toBe('completed') // the ROOT completes; the subagent error is a result

		const afterDispatch = yield* session.entries
		const started = subagentStartedEntries(afterDispatch)[0]
		if (started === undefined) throw new Error('expected the dispatched subagent to have started')

		// The subagent's own log carries the error facts.
		const subagentFinished = afterDispatch.findLast(
			(entry) => entry._tag === 'agent-finished' && entry.agentId === started.agentId,
		)
		if (subagentFinished?._tag !== 'agent-finished') throw new Error('expected the subagent to have finished')
		expect(subagentFinished.outcome).toBe('error')

		// The dispatcher's rendered result names the id, the error, and the resume guidance.
		const rendered = renderedDriveResult(afterDispatch, 0)
		expect(rendered).toContain(`agent_id: ${started.agentId}`)
		expect(rendered).toContain('finished with an error')
		expect(rendered).toContain('you may resume it')

		// Resuming the errored subagent works: it sees its failed-run history and completes.
		const resumed = yield* drive({ op: 'resume', agentId: started.agentId, prompt: 'try again' })
		expect(resumed.outcome).toBe('completed')

		const entries = yield* session.entries
		const resumedRendered = renderedDriveResult(entries, 1)
		expect(resumedRendered).toContain('recovered')
		expect(resumedRendered).not.toContain('finished with an error')

		const prompts = yield* flakyScripted.scripted.prompts
		expect(JSON.stringify(prompts[1])).toContain('try it')
		expect(JSON.stringify(prompts[1])).toContain('try again')
	}).pipe(Effect.scoped),
)

it.effect('a subagent that died from a defect is flattened into an error result and remains resumable', () =>
	Effect.gen(function* () {
		const explodeOnce = yield* Ref.make(true)
		const workerScripted = yield* scriptedModel(claudeActiveModel, [textTurn('recovered after defect')])
		const worker = defineSubagent({
			name: 'worker',
			description: 'dies once in a hook',
			model: workerScripted.model,
			hooks: {
				preRequest: [
					{
						name: 'explode-once',
						handler: () =>
							Effect.gen(function* () {
								const shouldExplode = yield* Ref.getAndSet(explodeOnce, false)
								if (shouldExplode) {
									return yield* Effect.die(new Error('hook exploded'))
								}
								return { _tag: 'unchanged' as const }
							}),
					},
				],
			},
		})

		const { session, drive } = yield* makeDriveSession({ definitions: [worker], rootTurns: 2 })

		const firstFinished = yield* drive({ op: 'dispatch', agent: 'worker', prompt: 'do work' })
		expect(firstFinished.outcome).toBe('completed') // the ROOT survives; the defect was flattened

		const afterDispatch = yield* session.entries
		const started = subagentStartedEntries(afterDispatch)[0]
		if (started === undefined) throw new Error('expected the dispatched subagent to have started')

		// The exit finalizer wrote the durable error marker for the dead subagent.
		const subagentFinished = afterDispatch.findLast(
			(entry) => entry._tag === 'agent-finished' && entry.agentId === started.agentId,
		)
		if (subagentFinished?._tag !== 'agent-finished') throw new Error('expected the subagent to have finished')
		expect(subagentFinished.outcome).toBe('error')
		expect(subagentFinished.reason).toContain('explode-once')

		// Flattened at the Subagents seam: a normal rendered result, not a generic tool failure.
		const rendered = renderedDriveResult(afterDispatch, 0)
		expect(rendered).toContain(`agent_id: ${started.agentId}`)
		expect(rendered).toContain('finished with an error')
		expect(rendered).toContain('explode-once')

		// Resume completes once the defect is gone, over the same log slice.
		const resumed = yield* drive({ op: 'resume', agentId: started.agentId, prompt: 'try again' })
		expect(resumed.outcome).toBe('completed')

		const entries = yield* session.entries
		expect(renderedDriveResult(entries, 1)).toContain('recovered after defect')
		expect(yield* workerScripted.scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)
