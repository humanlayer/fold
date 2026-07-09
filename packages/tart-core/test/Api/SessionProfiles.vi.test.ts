/**
 * Facade tests for session profiles: `startSession({ profiles })` seeds the session-wide role->model
 * map and `TartSession.setProfile` rebinds one role mid-session - children provision per dispatch, so
 * the swap binds the very NEXT dispatch of a role-bound type with no epoch machinery, while completed
 * runs keep their durable rows on the model that actually served them.
 */
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { defineSubagent } from '../../src/index'
import { makeDriveSession, subagentStartedEntries } from '../Subagents/DriveHarness'
import { textTurn } from '../TestLayers/ScriptedLanguageModel'
import { claudeActiveModel, gptActiveModel, scriptedModel } from './ApiTestHelpers'

it.effect('setProfile rebinds a role for the very next dispatch of the same type', () =>
	Effect.gen(function* () {
		const fastA = yield* scriptedModel({ ...claudeActiveModel, modelId: 'fast-a' }, [textTurn('served by a')])
		const fastB = yield* scriptedModel({ ...gptActiveModel, modelId: 'fast-b' }, [textTurn('served by b')])
		const researcher = defineSubagent({ name: 'researcher', description: 'explores', model: 'fast' })

		const { session, drive } = yield* makeDriveSession({
			definitions: [researcher],
			rootTurns: 2,
			profiles: { fast: fastA.model },
		})

		yield* drive({ op: 'dispatch', agent: 'researcher', prompt: 'first task' })
		yield* session.setProfile('fast', fastB.model)
		yield* drive({ op: 'dispatch', agent: 'researcher', prompt: 'second task' })

		// Two fresh children of ONE type, each provisioned on the binding current at its dispatch.
		const entries = yield* session.entries
		const started = subagentStartedEntries(entries)
		expect(started.map((entry) => entry.agentType)).toEqual(['researcher', 'researcher'])
		expect(started.map((entry) => entry.model.modelId)).toEqual(['fast-a', 'fast-b'])
		expect(new Set(started.map((entry) => entry.agentId)).size).toBe(2)

		// Each scripted provider served exactly its own dispatch.
		expect(yield* fastA.scripted.remainingTurns).toBe(0)
		expect(yield* fastB.scripted.remainingTurns).toBe(0)
		expect(yield* fastA.scripted.requests).toHaveLength(1)
		expect(yield* fastB.scripted.requests).toHaveLength(1)
	}).pipe(Effect.scoped),
)
