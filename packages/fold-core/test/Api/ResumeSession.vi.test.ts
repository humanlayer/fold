/**
 * Slice-2 resume tests: `resumeSession` ADOPTS an existing log - identity recovered from the replayed
 * `session_started`, no new session/agent rows - and the facade writes ONE epoch transition exactly
 * when the provided configuration no longer matches the log's projected root state: a different model
 * binding (D17 resume ruling) or different composed leading blocks (D20 resume rule - a changed skills
 * roster changes the block). An unchanged configuration writes nothing.
 */
import { expect, it } from '@effect/vitest'
import { Cause, Context, Effect, Exit, Layer } from 'effect'

import {
	defineAgent,
	EventLog,
	eventLogSource,
	layerInMemoryEventLog,
	resumeSession,
	startSession,
	type EventLogService,
} from '../../src/index'
import { textTurn } from '../TestLayers/ScriptedLanguageModel'
import { claudeActiveModel, gptActiveModel, scriptedModel } from './ApiTestHelpers'

/** One log service outliving the sessions under test - the in-memory stand-in for a JSONL file. */
const makeSharedLog = Effect.gen(function* () {
	const logContext = yield* Layer.build(layerInMemoryEventLog)
	return Context.get(logContext, EventLog)
})

/** Run one throwaway session against the shared log and return its identity. */
const runFirstSession = (sharedLog: EventLogService, systemPrompt: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const scripted = yield* scriptedModel(claudeActiveModel, [textTurn('first answer')])
			const session = yield* startSession({
				agent: defineAgent({ model: scripted.model, systemPrompt }),
				log: eventLogSource(Effect.succeed(sharedLog)),
			})
			const finished = yield* session.send('go')
			expect(finished.outcome).toBe('completed')
			return { sessionId: session.sessionId, rootAgentId: session.rootAgentId }
		}),
	)

it.effect('resume adopts the log: same ids, no new rows, full continuity - and no spurious transition', () =>
	Effect.gen(function* () {
		const sharedLog = yield* makeSharedLog
		const first = yield* runFirstSession(sharedLog, 'You are the assistant.')

		// Same model binding, same prompt: adoption must write NOTHING before the next send.
		const resumedScripted = yield* scriptedModel(claudeActiveModel, [textTurn('second answer')])
		const session = yield* resumeSession({
			agent: defineAgent({ model: resumedScripted.model, systemPrompt: 'You are the assistant.' }),
			log: eventLogSource(Effect.succeed(sharedLog)),
		})

		expect(session.sessionId).toBe(first.sessionId)
		expect(session.rootAgentId).toBe(first.rootAgentId)

		const beforeSend = yield* session.entries
		expect(beforeSend.filter((entry) => entry._tag === 'session_started')).toHaveLength(1)
		expect(beforeSend.filter((entry) => entry._tag === 'agent_started')).toHaveLength(1)
		expect(beforeSend.some((entry) => entry._tag === 'model-change')).toBe(false)

		// The next send continues the SAME agent over the replayed history.
		const finished = yield* session.send('continue where we left off')
		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('second answer')
		expect(finished.agentId).toBe(first.rootAgentId)

		const prompt = JSON.stringify((yield* resumedScripted.scripted.prompts)[0])
		expect(prompt).toContain('go')
		expect(prompt).toContain('first answer')
		expect(prompt).toContain('continue where we left off')
	}).pipe(Effect.scoped),
)

it.effect('resume with a different model binding writes one epoch transition (D17 resume ruling)', () =>
	Effect.gen(function* () {
		const sharedLog = yield* makeSharedLog
		yield* runFirstSession(sharedLog, 'You are the assistant.')

		// A different provider family: the transition re-renders the epoch for the new model.
		const resumedScripted = yield* scriptedModel(gptActiveModel, [textTurn('answered by the new model')])
		const session = yield* resumeSession({
			agent: defineAgent({ model: resumedScripted.model, systemPrompt: 'You are the assistant.' }),
			log: eventLogSource(Effect.succeed(sharedLog)),
		})

		const beforeSend = yield* session.entries
		const modelChange = beforeSend.findLast((entry) => entry._tag === 'model-change')
		if (modelChange === undefined || modelChange._tag !== 'model-change') {
			throw new Error('expected the resume model-change entry')
		}
		expect(modelChange.model.modelId).toBe('gpt-scripted')
		expect(modelChange.reason).toContain('resume')
		expect(beforeSend.some((entry) => entry._tag === 'tools-change')).toBe(true)

		const finished = yield* session.send('continue')
		expect(finished.resultText).toBe('answered by the new model')
	}).pipe(Effect.scoped),
)

it.effect('resume with changed leading blocks transitions too (D20 resume rule)', () =>
	Effect.gen(function* () {
		const sharedLog = yield* makeSharedLog
		yield* runFirstSession(sharedLog, 'prompt v1')

		// Same model binding; only the composed leading block set changed (the same comparison a
		// freshly scanned, changed skills roster would trip).
		const resumedScripted = yield* scriptedModel(claudeActiveModel, [textTurn('answered under v2')])
		const session = yield* resumeSession({
			agent: defineAgent({ model: resumedScripted.model, systemPrompt: 'prompt v2' }),
			log: eventLogSource(Effect.succeed(sharedLog)),
		})

		const beforeSend = yield* session.entries
		expect(beforeSend.some((entry) => entry._tag === 'model-change')).toBe(true)
		const newLeading = beforeSend.findLast((entry) => entry._tag === 'system-message')
		expect(JSON.stringify(newLeading)).toContain('prompt v2')

		// The new epoch's leading blocks bind on the resumed send.
		yield* session.send('continue')
		const prompt = JSON.stringify((yield* resumedScripted.scripted.prompts)[0])
		expect(prompt).toContain('prompt v2')
		expect(prompt).not.toContain('prompt v1')
	}).pipe(Effect.scoped),
)

it.effect('resuming an empty log is a defect with instructive guidance', () =>
	Effect.gen(function* () {
		const sharedLog = yield* makeSharedLog
		const scripted = yield* scriptedModel(claudeActiveModel, [])

		const exit = yield* resumeSession({
			agent: defineAgent({ model: scripted.model }),
			log: eventLogSource(Effect.succeed(sharedLog)),
		}).pipe(Effect.exit)

		if (!Exit.isFailure(exit)) throw new Error('expected resume on an empty log to defect')
		expect(String(Cause.squash(exit.cause))).toContain('no session_started')
	}).pipe(Effect.scoped),
)
