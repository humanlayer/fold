/**
 * Engine tests for per-agent rosters (D21, round-five shape): the roster is the subagentTool value's
 * argument - each value advertises exactly its own roster and its closure is the dispatch authority -
 * so depth is roster nesting (a type carrying its own subagentTool dispatches grandchildren), an
 * out-of-roster type comes back as an instructive typed failure, and duplicate type names across
 * distinct definitions are a session-start defect.
 */
import { expect, it } from '@effect/vitest'
import { Cause, Effect, Exit } from 'effect'

import { defineAgent, defineSubagent, startSession, subagentTool, type ToolResultLogEntry } from '../../src/index'
import { claudeActiveModel, gptActiveModel, scriptedModel } from '../Api/ApiTestHelpers'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { subagentStartedEntries } from './DriveHarness'

it.effect('each subagentTool value advertises exactly its own roster', () =>
	Effect.gen(function* () {
		const scripted = yield* scriptedModel(claudeActiveModel, [])
		const alpha = defineSubagent({ name: 'alpha', description: 'first specialist', model: scripted.model })
		const beta = defineSubagent({ name: 'beta', description: 'second specialist', model: scripted.model })

		const wide = yield* subagentTool([alpha, beta]).init
		const narrow = yield* subagentTool([beta]).init

		expect(wide.tool.description).toContain('- alpha: first specialist')
		expect(wide.tool.description).toContain('- beta: second specialist')
		expect(narrow.tool.description).not.toContain('alpha')
		expect(narrow.tool.description).toContain('- beta: second specialist')
	}).pipe(Effect.scoped),
)

it.effect('nested rosters give depth; out-of-roster dispatch fails instructively; envelopes chain', () =>
	Effect.gen(function* () {
		const researcherScripted = yield* scriptedModel(claudeActiveModel, [textTurn('grandchild findings')])
		const researcher = defineSubagent({
			name: 'researcher',
			description: 'explores',
			model: researcherScripted.model,
		})

		// generalPurpose may dispatch ONLY researcher; its model first tries to dispatch itself
		// (out of roster - typed failure it can read), then dispatches the researcher, then finishes.
		const generalScripted = yield* scriptedModel(claudeActiveModel, [
			toolCallTurn([
				{
					id: 'gp-call-1',
					name: 'subagent',
					params: { description: 'self', prompt: 'recurse', agent: 'general-purpose' },
				},
			]),
			toolCallTurn([
				{
					id: 'gp-call-2',
					name: 'subagent',
					params: { description: 'delegate', prompt: 'explore the module', agent: 'researcher' },
				},
			]),
			textTurn('delegated and done'),
		])
		const generalPurpose = defineSubagent({
			name: 'general-purpose',
			description: 'delegates',
			model: generalScripted.model,
			tools: [subagentTool([researcher])],
		})

		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([
				{
					id: 'root-call-1',
					name: 'subagent',
					params: { description: 'gp', prompt: 'do the thing', agent: 'general-purpose' },
				},
			]),
			textTurn('root done'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				model: rootScripted.model,
				tools: [subagentTool([generalPurpose, researcher])],
			}),
		})

		const finished = yield* session.send('go')
		expect(finished.outcome).toBe('completed')

		const entries = yield* session.entries
		const started = subagentStartedEntries(entries)
		expect(started.map((entry) => entry.agentType)).toEqual(['general-purpose', 'researcher'])

		// The grandchild's parent is generalPurpose, not the root (envelope chain).
		const generalStarted = started[0]
		const grandchildStarted = started[1]
		expect(grandchildStarted?.parentAgentId).toBe(generalStarted?.agentId)

		// The out-of-roster attempt came back schema-encoded with the caller's available list.
		const toolResults = entries.filter((entry): entry is ToolResultLogEntry => entry._tag === 'tool-result')
		const selfDispatchResult = toolResults.find(
			(entry) => entry.agentId === generalStarted?.agentId && JSON.stringify(entry).includes('not available'),
		)
		if (selfDispatchResult === undefined) throw new Error('expected the out-of-roster failure result')
		const renderedFailure = JSON.stringify(selfDispatchResult.message.content[0])
		expect(renderedFailure).toContain('Agent type \\"general-purpose\\" is not available to you')
		expect(renderedFailure).toContain('researcher')
	}).pipe(Effect.scoped),
)

it.effect('duplicate type names across distinct definitions defect at session start', () =>
	Effect.gen(function* () {
		const scripted = yield* scriptedModel(claudeActiveModel, [])
		const first = defineSubagent({ name: 'twin', description: 'one', model: scripted.model })
		const second = defineSubagent({ name: 'twin', description: 'two', model: scripted.model })

		const exit = yield* startSession({
			agent: defineAgent({ model: scripted.model, tools: [subagentTool([first, second])] }),
		}).pipe(Effect.exit)

		if (!Exit.isFailure(exit)) throw new Error('expected session start to defect')
		expect(String(Cause.squash(exit.cause))).toContain('duplicate subagent type name')
	}).pipe(Effect.scoped),
)

it.effect('the same definition shared by two rosters is one registry entry', () =>
	Effect.gen(function* () {
		const sharedScripted = yield* scriptedModel(claudeActiveModel, [textTurn('shared findings')])
		const shared = defineSubagent({ name: 'shared', description: 'shared', model: sharedScripted.model })
		const middle = defineSubagent({
			name: 'middle',
			description: 'middle',
			model: sharedScripted.model,
			tools: [subagentTool([shared])],
		})

		const rootScripted = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([{ id: 'r1', name: 'subagent', params: { description: 'd', prompt: 'p', agent: 'shared' } }]),
			textTurn('done'),
		])

		// `shared` is reachable through the root roster AND through middle's roster: one entry, no defect.
		const session = yield* startSession({
			agent: defineAgent({
				model: rootScripted.model,
				tools: [subagentTool([middle, shared])],
			}),
		})

		const finished = yield* session.send('go')
		expect(finished.outcome).toBe('completed')
	}).pipe(Effect.scoped),
)
