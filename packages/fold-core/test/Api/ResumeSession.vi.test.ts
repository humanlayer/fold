import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
/**
 * Slice-2 resume tests: `resumeSession` ADOPTS an existing log - identity recovered from the replayed
 * `session_started`, no new session/agent rows - and the facade writes ONE epoch transition exactly
 * when the provided configuration no longer matches the log's projected root state: a different model
 * binding (D17 resume ruling) or different composed leading blocks (D20 resume rule - a changed skills
 * roster changes the block). An unchanged configuration writes nothing.
 */
import { expect, it } from '@effect/vitest'
import { Predicate, Cause, Context, Effect, Exit, Layer, Schema } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import {
	defineAgent,
	EventLog,
	eventLogSource,
	layerInMemoryEventLog,
	MessageId,
	resumeSession,
	startSession,
	ToolCallId,
	type ActiveModel,
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
		expect(beforeSend.filter((entry) => Predicate.isTagged(entry, 'session_started'))).toHaveLength(1)
		expect(beforeSend.filter((entry) => Predicate.isTagged(entry, 'agent_started'))).toHaveLength(1)
		expect(beforeSend.some((entry) => Predicate.isTagged(entry, 'model-change'))).toBe(false)

		// The next send continues the SAME agent over the replayed history.
		const finished = yield* session.send('continue where we left off')
		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('second answer')
		expect(finished.agentId).toBe(first.rootAgentId)

		const prompt = JSON.stringify((yield* resumedScripted.scripted.prompts)[0])
		expect(prompt).toContain('go')
		expect(prompt).toContain('first answer')
		expect(prompt).toContain('continue where we left off')
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)

it.effect('resume supplies a request-local failed result for a persisted dangling tool call', () =>
	Effect.gen(function* () {
		const sharedLog = yield* makeSharedLog
		const first = yield* runFirstSession(sharedLog, 'You are the assistant.')
		const danglingToolCallId = ToolCallId.make('tool_call_aaaaaaaaaaaaaaaaaaaaaaaa')

		yield* sharedLog.append({
			_tag: 'assistant-message',
			agentId: first.rootAgentId,
			parentAgentId: null,
			toolCallId: null,
			messageId: MessageId.make('msg_aaaaaaaaaaaaaaaaaaaaaaaa'),
			message: yield* Schema.encodeUnknownEffect(Prompt.AssistantMessage)(
				Prompt.assistantMessage({
					content: [
						Prompt.toolCallPart({
							id: danglingToolCallId,
							name: 'echo',
							params: { text: 'possibly completed' },
							providerExecuted: false,
							options: { fold: { providerToolCallId: 'provider-dangling-call' } },
						}),
					],
				}),
			),
			finish: null,
		})

		const resumedScripted = yield* scriptedModel(claudeActiveModel, [textTurn('recovered')])
		const session = yield* resumeSession({
			agent: defineAgent({ model: resumedScripted.model, systemPrompt: 'You are the assistant.' }),
			log: eventLogSource(Effect.succeed(sharedLog)),
		})

		const finished = yield* session.send('continue')
		expect(finished.resultText).toBe('recovered')

		const prompt = (yield* resumedScripted.scripted.prompts)[0]
		if (prompt === undefined) throw new Error('expected a resumed provider prompt')
		const toolResult = prompt.content
			.flatMap((message) => (message.role === 'tool' ? message.content : []))
			.find((part) => part.type === 'tool-result')
		if (toolResult?.type !== 'tool-result') throw new Error('expected a synthetic tool result')

		expect(toolResult).toMatchObject({
			id: 'provider-dangling-call',
			name: 'echo',
			isFailure: true,
			providerExecuted: false,
			result: '<system-information>No result was recorded for this tool call. The reason is unknown. The tool may have completed; check the current state before retrying.</system-information>',
		})

		const durableEntries = yield* session.entries
		expect(
			durableEntries.some(
				(entry) => Predicate.isTagged(entry, 'tool-result') && entry.toolCallId === danglingToolCallId,
			),
		).toBe(false)
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
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
		const modelChange = beforeSend.findLast((entry) => Predicate.isTagged(entry, 'model-change'))
		if (modelChange === undefined || !Predicate.isTagged(modelChange, 'model-change')) {
			throw new Error('expected the resume model-change entry')
		}
		expect(modelChange.model.modelId).toBe('gpt-scripted')
		expect(modelChange.reason).toContain('resume')
		expect(beforeSend.some((entry) => Predicate.isTagged(entry, 'tools-change'))).toBe(true)

		const finished = yield* session.send('continue')
		expect(finished.resultText).toBe('answered by the new model')
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)

it.effect('resume records exactly one durable transition from GPT-6 Sol to Luna', () =>
	Effect.gen(function* () {
		const sharedLog = yield* makeSharedLog
		const sol: ActiveModel = {
			...gptActiveModel,
			providerId: 'codex',
			providerKind: 'codex',
			modelId: 'gpt-6-sol',
			requestedReasoningLevel: 'max',
			reasoning: { _tag: 'effort', effort: 'max', summary: 'auto' },
		}
		const luna: ActiveModel = { ...sol, modelId: 'gpt-6-luna' }

		yield* Effect.scoped(
			Effect.gen(function* () {
				const first = yield* scriptedModel(sol, [textTurn('first answer')])
				const session = yield* startSession({
					agent: defineAgent({ model: first.model, systemPrompt: 'You are the assistant.' }),
					log: eventLogSource(Effect.succeed(sharedLog)),
				})
				yield* session.send('go')
			}),
		)

		const resumed = yield* scriptedModel(luna, [textTurn('second answer')])
		const session = yield* resumeSession({
			agent: defineAgent({ model: resumed.model, systemPrompt: 'You are the assistant.' }),
			log: eventLogSource(Effect.succeed(sharedLog)),
		})
		const entries = yield* session.entries
		const modelChanges = entries.filter((entry) => Predicate.isTagged(entry, 'model-change'))

		expect(modelChanges).toHaveLength(1)
		expect(modelChanges[0]).toMatchObject({ model: { modelId: 'gpt-6-luna' } })
		yield* session.send('continue')
		expect((yield* resumed.scripted.requests)[0]?.openAiConfig?.model).toBe('gpt-6-luna')
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
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
		expect(beforeSend.some((entry) => Predicate.isTagged(entry, 'model-change'))).toBe(true)
		const newLeading = beforeSend.findLast((entry) => Predicate.isTagged(entry, 'system-message'))
		expect(JSON.stringify(newLeading)).toContain('prompt v2')

		// The new epoch's leading blocks bind on the resumed send.
		yield* session.send('continue')
		const prompt = JSON.stringify((yield* resumedScripted.scripted.prompts)[0])
		expect(prompt).toContain('prompt v2')
		expect(prompt).not.toContain('prompt v1')
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
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
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)
