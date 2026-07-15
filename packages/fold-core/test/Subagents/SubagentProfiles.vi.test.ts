/**
 * Engine tests for role-bound subagent models (profiles slice): a registry entry may bind `model` to a
 * profile role name instead of a concrete descriptor, resolved through the session's mutable profiles
 * map at every dispatch/resume - so the profiles-bound model serves the child, `orchestrator` falls
 * back to `smart` (D25), a resume after a `setProfile` swap writes the child's durable `model-change`
 * transition (the existing D17 diff machinery over the freshly resolved binding), an uncovered role
 * defects at session start, and concrete bindings keep working with no profiles passed at all.
 */
import { expect, it } from '@effect/vitest'
import { Cause, Effect, Exit } from 'effect'

import { defineAgent, defineSubagent, startSession, subagentTool, type ModelChangeLogEntry } from '../../src/index'
import { claudeActiveModel, gptActiveModel, scriptedModel } from '../Api/ApiTestHelpers'
import { textTurn } from '../TestLayers/ScriptedLanguageModel'
import { makeDriveSession, subagentStartedEntries } from './DriveHarness'

it.effect('a role-bound subagent dispatches on the profiles-bound model', () =>
	Effect.gen(function* () {
		const fastScripted = yield* scriptedModel({ ...claudeActiveModel, modelId: 'fast-bound' }, [
			textTurn('fast findings'),
		])
		const researcher = defineSubagent({ name: 'researcher', description: 'explores', model: 'fast' })

		const { session, drive } = yield* makeDriveSession({
			definitions: [researcher],
			rootTurns: 1,
			profiles: { fast: fastScripted.model },
		})

		const finished = yield* drive({ op: 'dispatch', agent: 'researcher', prompt: 'explore the module' })
		expect(finished.outcome).toBe('completed')

		// The durable child row binds the resolved model, and the fast script actually served the run.
		const entries = yield* session.entries
		const started = subagentStartedEntries(entries)[0]
		expect(started?.agentType).toBe('researcher')
		expect(started?.model.modelId).toBe('fast-bound')
		expect(yield* fastScripted.scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

it.effect('resuming a subagent dispatched before a setProfile swap writes the child model-change', () =>
	Effect.gen(function* () {
		const fastA = yield* scriptedModel({ ...claudeActiveModel, modelId: 'fast-a' }, [textTurn('first findings')])
		const fastB = yield* scriptedModel({ ...gptActiveModel, modelId: 'fast-b' }, [textTurn('resumed findings')])
		const researcher = defineSubagent({ name: 'researcher', description: 'explores', model: 'fast' })

		const { session, drive } = yield* makeDriveSession({
			definitions: [researcher],
			rootTurns: 2,
			profiles: { fast: fastA.model },
		})

		yield* drive({ op: 'dispatch', agent: 'researcher', prompt: 'first task' })
		const afterDispatch = yield* session.entries
		const started = subagentStartedEntries(afterDispatch)[0]
		if (started === undefined) throw new Error('expected the dispatched subagent to have started')
		expect(started.model.modelId).toBe('fast-a')

		yield* session.setProfile('fast', fastB.model)
		yield* drive({ op: 'resume', agentId: started.agentId, prompt: 'keep going' })

		// The resume resolved the fresh binding, saw it differ from the projected last model, and wrote
		// the durable D17 transition for the CHILD agent before re-entering its loop.
		const entries = yield* session.entries
		const childModelChange = entries.find(
			(entry): entry is ModelChangeLogEntry => entry._tag === 'model-change' && entry.agentId === started.agentId,
		)
		expect(childModelChange?.model.modelId).toBe('fast-b')

		// The resumed run was served by the NEW script, over the child's full prior history.
		expect(yield* fastB.scripted.remainingTurns).toBe(0)
		const resumedPrompt = JSON.stringify((yield* fastB.scripted.prompts)[0])
		expect(resumedPrompt).toContain('first findings')
		expect(resumedPrompt).toContain('keep going')
	}).pipe(Effect.scoped),
)

it.effect('an orchestrator-bound subagent falls back to the smart profile when orchestrator is unbound', () =>
	Effect.gen(function* () {
		const smartScripted = yield* scriptedModel({ ...gptActiveModel, modelId: 'smart-bound' }, [textTurn('planned')])
		const planner = defineSubagent({ name: 'planner', description: 'plans', model: 'orchestrator' })

		const { session, drive } = yield* makeDriveSession({
			definitions: [planner],
			rootTurns: 1,
			profiles: { smart: smartScripted.model },
		})

		const finished = yield* drive({ op: 'dispatch', agent: 'planner', prompt: 'plan the work' })
		expect(finished.outcome).toBe('completed')

		const entries = yield* session.entries
		expect(subagentStartedEntries(entries)[0]?.model.modelId).toBe('smart-bound')
		expect(yield* smartScripted.scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

it.effect('a role-bound roster with no covering profile binding defects at session start', () =>
	Effect.gen(function* () {
		const scripted = yield* scriptedModel(claudeActiveModel, [])
		const researcher = defineSubagent({ name: 'researcher', description: 'explores', model: 'fast' })

		const exit = yield* startSession({
			agent: defineAgent({ model: scripted.model, tools: [subagentTool([researcher])] }),
		}).pipe(Effect.exit)

		if (!Exit.isFailure(exit)) throw new Error('expected session start to defect')
		const rendered = String(Cause.squash(exit.cause))
		expect(rendered).toContain('subagent type "researcher" binds model role "fast"')
		expect(rendered).toContain('profiles.fast')
	}).pipe(Effect.scoped),
)

it.effect('an orchestrator binding is only covered by orchestrator or smart profiles', () =>
	Effect.gen(function* () {
		const scripted = yield* scriptedModel(claudeActiveModel, [])
		const planner = defineSubagent({ name: 'planner', description: 'plans', model: 'orchestrator' })

		const exit = yield* startSession({
			agent: defineAgent({ model: scripted.model, tools: [subagentTool([planner])] }),
			profiles: { fast: scripted.model },
		}).pipe(Effect.exit)

		if (!Exit.isFailure(exit)) throw new Error('expected session start to defect')
		expect(String(Cause.squash(exit.cause))).toContain('profiles.orchestrator (or profiles.smart)')
	}).pipe(Effect.scoped),
)

it.effect('concrete model bindings keep working with no profiles passed (regression)', () =>
	Effect.gen(function* () {
		const concreteScripted = yield* scriptedModel({ ...claudeActiveModel, modelId: 'concrete' }, [
			textTurn('concrete findings'),
		])
		const worker = defineSubagent({ name: 'worker', description: 'works', model: concreteScripted.model })

		const { session, drive } = yield* makeDriveSession({ definitions: [worker], rootTurns: 1 })

		const finished = yield* drive({ op: 'dispatch', agent: 'worker', prompt: 'do the work' })
		expect(finished.outcome).toBe('completed')

		const entries = yield* session.entries
		expect(subagentStartedEntries(entries)[0]?.model.modelId).toBe('concrete')
		expect(yield* concreteScripted.scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)
