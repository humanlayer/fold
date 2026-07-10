/**
 * Facade-level auto-compaction tests (D11): sessions configured with `autoCompact` compact at the
 * top-of-turn threshold and on reactive provider overflow, write durable `compaction` entries, and
 * keep running - all driven through `startSession`/`resumeSession` with scripted models, exactly as
 * SDK callers configure it. The summarization call runs on the session's own scripted model, so each
 * script interleaves the summarizer's response at the position the loop calls it.
 *
 * Key claims covered: only messages after the cut reach the model (the summary stands in for the
 * rest), the session keeps running across and after compaction, pre-compaction configuration
 * (tools, model, leading prompt) survives, stale pre-compaction usage never re-triggers, incremental
 * compaction threads the previous summary, overflow recovery retries exactly once, summarizer
 * failures degrade to a durable error note, and a resumed log projects the compacted history.
 */
import { expect, it } from '@effect/vitest'
import { Context, Effect, Layer } from 'effect'

import {
	defineAgent,
	eventLogSource,
	layerInMemoryEventLog,
	messagesForAgent,
	resumeSession,
	runtimeForAgent,
	startSession,
	EventLog,
	type AutoCompactConfig,
	type CompactionArchiveAccessService,
	type CompactionLogEntry,
	type ErrorLogEntry,
	type EventLogService,
	type LogEntry,
	type ModelCatalogEntry,
	type UserMessageLogEntry,
} from '../../src/index'
import { failureTurn, textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { echoTool, gptActiveModel, scriptedModel } from './../Api/ApiTestHelpers'

/**
 * Small-window config for deterministic triggering: usable = 10000 - 2500 - 1250 = 6250 tokens, so
 * a scripted response reporting ~7000 input tokens trips the threshold, and a 10-token keep budget
 * makes the cut land after the first message or two of tiny test conversations.
 */
const compactConfig: AutoCompactConfig = { enabled: true, contextWindow: 10_000, keepRecentTokens: 10 }

/** Usage that exceeds the configured usable budget on the next check. */
const hugeUsage = { inputTokens: 7_000 }

const compactionEntries = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<CompactionLogEntry> =>
	entries.filter((entry): entry is CompactionLogEntry => entry._tag === 'compaction')

const errorEntries = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<ErrorLogEntry> =>
	entries.filter((entry): entry is ErrorLogEntry => entry._tag === 'error')

const userEntries = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<UserMessageLogEntry> =>
	entries.filter((entry): entry is UserMessageLogEntry => entry._tag === 'user-message')

it.effect('compacts mid-run at the threshold and keeps running; config from before the cut survives', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			// Turn 1: a tool call whose reported usage exceeds the budget - the NEXT turn compacts.
			toolCallTurn([{ id: 'provider-call-1', name: 'echo', params: { text: 'x'.repeat(100) } }], hugeUsage),
			// Turn 2 opens with the summarization call, then the real request continues the run.
			textTurn('## Goal\n- compaction demo summary'),
			textTurn('all done'),
		])
		const archiveAccess: CompactionArchiveAccessService = {
			instructions: ({ agentId }) => Effect.succeed(`<archive-access>agent=${agentId}</archive-access>`),
		}

		const session = yield* startSession({
			agent: defineAgent({
				model,
				systemPrompt: 'You are the compaction demo agent.',
				tools: [echoTool],
				autoCompact: compactConfig,
			}),
			compactionArchiveAccess: archiveAccess,
		})

		const finished = yield* session.send('use echo with the big payload')
		const entries = yield* session.entries

		// The run survived the mid-run compaction and completed normally.
		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('all done')

		// Exactly one durable compaction entry, under the root run's envelope, cutting through the
		// user message (the tool exchange is the kept tail) and recording the triggering usage.
		const compactions = compactionEntries(entries)
		expect(compactions).toHaveLength(1)
		const compaction = compactions[0]
		if (compaction === undefined) throw new Error('expected a compaction entry')
		expect(compaction.agentId).toBe(session.rootAgentId)
		expect(compaction.parentAgentId).toBeNull()
		expect(compaction.toolCallId).toBeNull()
		expect(compaction.summary).toContain('compaction demo summary')
		expect(compaction.postCompactionInstructions).toBe(
			`<archive-access>agent=${session.rootAgentId}</archive-access>`,
		)
		expect(compaction.tokensBefore).toBe(7_005)
		expect(compaction.replacesThroughSeq).toBe(userEntries(entries)[0]?.seq)

		const requests = yield* scripted.requests
		expect(requests).toHaveLength(3)

		// The summarization request: no tools advertised, pi's system prompt and default instruction,
		// and the replaced history serialized inside <conversation>.
		const summarizeRequest = JSON.stringify(requests[1]?.prompt)
		expect(requests[1]?.toolNames).toEqual([])
		expect(summarizeRequest).toContain('context summarization assistant')
		expect(summarizeRequest).toContain('structured context checkpoint summary')
		expect(summarizeRequest).toContain('[User]: use echo with the big payload')
		expect(summarizeRequest).not.toContain('<archive-access>')

		// The post-compaction request: the summary stands in for the replaced user message, the kept
		// tool exchange is still there verbatim, and the epoch configuration is untouched - same
		// leading prompt, same advertised tools.
		const finalRequest = JSON.stringify(requests[2]?.prompt)
		expect(finalRequest).toContain('<conversation-summary>')
		expect(finalRequest).toContain('compaction demo summary')
		expect(finalRequest).toContain(`<archive-access>agent=${session.rootAgentId}</archive-access>`)
		expect(finalRequest).not.toContain('use echo with the big payload')
		expect(finalRequest).toContain('x'.repeat(100))
		expect(finalRequest).toContain('You are the compaction demo agent.')
		expect(requests[2]?.toolNames).toEqual(['echo'])

		// Projection read models agree: the summary leads the conversation, and the runtime fold
		// (model, tools, reasoning) is untouched by the cut - those facts predate the compaction.
		const projected = messagesForAgent(entries, session.rootAgentId)
		expect(projected[0]?._tag).toBe('system-message')
		expect(projected[1]?._tag).toBe('compaction-summary')
		const runtime = runtimeForAgent(entries, session.rootAgentId)
		expect(runtime.activeModel?.modelId).toBe('gpt-scripted')
		expect(runtime.activeTools).toEqual(['echo'])

		expect(yield* scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

it.effect(
	'compacts across sends and incrementally: only the newest summary and post-cut messages reach the model',
	() =>
		Effect.gen(function* () {
			const { model, scripted } = yield* scriptedModel(gptActiveModel, [
				// Send 1: a long answer reporting huge usage - send 2 opens by compacting.
				textTurn(`noted. ${'p'.repeat(120)}`, hugeUsage),
				textTurn('## Goal\n- sky summary'),
				// Send 2's real answer is long and huge again - send 3 compacts incrementally.
				textTurn(`answer two. ${'q'.repeat(120)}`, { inputTokens: 7_200 }),
				textTurn('## Goal\n- combined summary v2'),
				textTurn('third answer'),
			])

			const session = yield* startSession({
				agent: defineAgent({ model, systemPrompt: 'Assistant.', autoCompact: compactConfig }),
			})

			yield* session.send('first topic: the sky is teal today')
			yield* session.send('second topic please')
			const third = yield* session.send('third topic')
			const entries = yield* session.entries

			expect(third.outcome).toBe('completed')
			expect(third.resultText).toBe('third answer')

			const compactions = compactionEntries(entries)
			expect(compactions).toHaveLength(2)

			const requests = yield* scripted.requests
			expect(requests).toHaveLength(5)

			// First summarization: no previous summary - the initial instruction.
			const firstSummarize = JSON.stringify(requests[1]?.prompt)
			expect(firstSummarize).toContain('[User]: first topic: the sky is teal today')
			expect(firstSummarize).not.toContain('<previous-summary>')

			// Send 2's request: summary one stands in for the first topic.
			const secondSend = JSON.stringify(requests[2]?.prompt)
			expect(secondSend).toContain('sky summary')
			expect(secondSend).not.toContain('sky is teal')
			expect(secondSend).toContain('second topic please')

			// Second summarization: incremental - the previous summary rides in <previous-summary> and
			// the update instruction replaces the initial one.
			const secondSummarize = JSON.stringify(requests[3]?.prompt)
			expect(secondSummarize).toContain('<previous-summary>')
			expect(secondSummarize).toContain('sky summary')
			expect(secondSummarize).toContain('NEW conversation messages')

			// Send 3's request: ONLY the newest summary renders (latest compaction wins); the previously
			// kept-then-summarized messages are gone; the new kept tail and the new message are present.
			const thirdSend = JSON.stringify(requests[4]?.prompt)
			expect(thirdSend).toContain('combined summary v2')
			expect(thirdSend).not.toContain('sky summary')
			expect(thirdSend).not.toContain('second topic please')
			expect(thirdSend).toContain('answer two.')
			expect(thirdSend).toContain('third topic')

			expect(yield* scripted.remainingTurns).toBe(0)
		}).pipe(Effect.scoped),
)

it.effect('stale pre-compaction usage never re-triggers: no second compaction without a fresh response', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			textTurn(`big reply ${'r'.repeat(120)}`, hugeUsage),
			// Send 2: compaction succeeds, then the model call itself fails (NOT an overflow) - the run
			// ends error with no post-compaction usage on record.
			textTurn('## Goal\n- first summary'),
			failureTurn('boom'),
			// Send 3 must NOT compact again: the only reported usage predates the compaction.
			textTurn('recovered fine'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model, autoCompact: compactConfig }),
		})

		yield* session.send('topic one anchor text')
		const second = yield* session.send('topic two')
		const third = yield* session.send('topic three')
		const entries = yield* session.entries

		expect(second.outcome).toBe('error')
		expect(third.outcome).toBe('completed')
		expect(third.resultText).toBe('recovered fine')

		expect(compactionEntries(entries)).toHaveLength(1)

		// Send 3 ran against the compacted projection without compacting again.
		const requests = yield* scripted.requests
		const thirdSend = JSON.stringify(requests[3]?.prompt)
		expect(thirdSend).toContain('first summary')
		expect(thirdSend).not.toContain('topic one anchor text')

		expect(yield* scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

it.effect('compaction is off by default and with enabled: false, even under huge reported usage', () =>
	Effect.gen(function* () {
		const runWithout = (autoCompact: AutoCompactConfig | undefined) =>
			Effect.gen(function* () {
				const { model, scripted } = yield* scriptedModel(gptActiveModel, [
					textTurn('first', hugeUsage),
					textTurn('second'),
				])
				const session = yield* startSession({
					agent: defineAgent({
						model,
						...(autoCompact === undefined ? {} : { autoCompact }),
					}),
				})

				yield* session.send('one: the anchor phrase')
				const finished = yield* session.send('two')
				const entries = yield* session.entries

				expect(finished.outcome).toBe('completed')
				expect(compactionEntries(entries)).toHaveLength(0)

				// The full history still reaches the model - nothing was cut or summarized.
				const requests = yield* scripted.requests
				expect(JSON.stringify(requests[1]?.prompt)).toContain('one: the anchor phrase')
			}).pipe(Effect.scoped)

		yield* runWithout(undefined)
		yield* runWithout({ enabled: false })
	}),
)

it.effect('a configured compactionPrompt replaces the default instruction template', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			textTurn(`long answer ${'w'.repeat(120)}`, hugeUsage),
			textTurn('CUSTOM CHECKPOINT: compact haiku'),
			textTurn('continuing'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				model,
				autoCompact: { ...compactConfig, compactionPrompt: 'Reply with a CUSTOM CHECKPOINT of the work.' },
			}),
		})

		yield* session.send('start topic')
		const finished = yield* session.send('next topic')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')
		expect(compactionEntries(entries)[0]?.summary).toContain('CUSTOM CHECKPOINT')

		const summarizeRequest = JSON.stringify((yield* scripted.requests)[1]?.prompt)
		expect(summarizeRequest).toContain('Reply with a CUSTOM CHECKPOINT of the work.')
		expect(summarizeRequest).not.toContain('structured context checkpoint summary')
		// The framing around the instruction is fixed: the transcript still rides in <conversation>.
		expect(summarizeRequest).toContain('<conversation>')
	}).pipe(Effect.scoped),
)

it.effect('a summarizer failure degrades to a durable error note; the run proceeds uncompacted', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			textTurn(`anchor answer ${'s'.repeat(120)}`, hugeUsage),
			// The summarization call itself fails...
			failureTurn('summarizer exploded'),
			// ...and the turn proceeds against the full, uncompacted history.
			textTurn('answered anyway'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model, autoCompact: compactConfig }),
		})

		yield* session.send('anchor question one')
		const finished = yield* session.send('question two')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('answered anyway')

		expect(compactionEntries(entries)).toHaveLength(0)
		const errors = errorEntries(entries)
		expect(errors).toHaveLength(1)
		expect(errors[0]?.errorType).toBe('compaction')
		expect(errors[0]?.message).toContain('summarizer exploded')

		// Uncompacted means the full history reached the model.
		const finalRequest = JSON.stringify((yield* scripted.requests)[2]?.prompt)
		expect(finalRequest).toContain('anchor question one')
	}).pipe(Effect.scoped),
)

it.effect('reactive overflow: compact and retry the turn once, then the run completes cleanly', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			textTurn(`anchor reply ${'t'.repeat(120)}`),
			// Send 2's first attempt overflows; the loop compacts and restarts the turn.
			failureTurn('request failed: context_length_exceeded'),
			textTurn('## Goal\n- overflow summary'),
			textTurn('recovered answer'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model, autoCompact: compactConfig }),
		})

		yield* session.send('the launch code is 4242')
		const finished = yield* session.send('now do the follow-up')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('recovered answer')

		expect(compactionEntries(entries)).toHaveLength(1)
		// A recovered overflow is transient: no durable error entries anywhere.
		expect(errorEntries(entries)).toHaveLength(0)

		const retriedRequest = JSON.stringify((yield* scripted.requests)[3]?.prompt)
		expect(retriedRequest).toContain('overflow summary')
		expect(retriedRequest).not.toContain('launch code is 4242')
		expect(retriedRequest).toContain('now do the follow-up')

		expect(yield* scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

it.effect('overflow recovery runs once per run: a second overflow becomes the durable error outcome', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			textTurn(`anchor ${'u'.repeat(120)}`),
			failureTurn('context_length_exceeded'),
			textTurn('## Goal\n- attempt summary'),
			failureTurn('context_length_exceeded again'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model, autoCompact: compactConfig }),
		})

		yield* session.send('seed')
		const finished = yield* session.send('go')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('error')
		expect(compactionEntries(entries)).toHaveLength(1)

		const errors = errorEntries(entries)
		expect(errors).toHaveLength(1)
		expect(errors[0]?.errorType).toBe('model')
		expect(errors[0]?.message).toContain('context_length_exceeded again')

		expect(yield* scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

/** A catalog row for the scripted model; only the context window matters to compaction. */
const scriptedCatalogEntry = (contextWindow: number): ModelCatalogEntry => ({
	providerId: 'scripted-openai',
	modelId: 'gpt-scripted',
	name: null,
	contextWindow,
	maxInputTokens: null,
	maxOutputTokens: 32_000,
	reasoning: false,
	reasoningEfforts: null,
	vision: false,
	toolCall: true,
	pricing: null,
})

it.effect('a session-provided catalog supplies the compaction context window (no explicit override)', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			// Send 1 reports usage over the CATALOG window's usable budget - send 2 opens by compacting.
			textTurn(`noted. ${'c'.repeat(120)}`, hugeUsage),
			textTurn('## Goal\n- catalog-window summary'),
			textTurn('post-catalog-compaction answer'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				model,
				// No autoCompact.contextWindow: the window must come from the session catalog (10k ->
				// usable 6250, and hugeUsage reports 7005).
				autoCompact: { enabled: true, keepRecentTokens: 10 },
			}),
			catalog: [scriptedCatalogEntry(10_000)],
		})

		yield* session.send('catalog topic one anchor')
		const finished = yield* session.send('catalog topic two')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('post-catalog-compaction answer')
		expect(compactionEntries(entries)).toHaveLength(1)

		// The compacted request proves the catalog window drove a real cut.
		const secondSend = JSON.stringify((yield* scripted.requests)[2]?.prompt)
		expect(secondSend).toContain('catalog-window summary')
		expect(secondSend).not.toContain('catalog topic one anchor')

		expect(yield* scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

it.effect('an explicit autoCompact.contextWindow beats the catalog entry', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			textTurn(`noted. ${'e'.repeat(120)}`, hugeUsage),
			textTurn('## Goal\n- override summary'),
			textTurn('override answer'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				model,
				// The explicit 10k window compacts on 7005 reported tokens; the catalog's 1M window
				// would not (usable ~951k) - so a compaction proves the override won.
				autoCompact: { enabled: true, contextWindow: 10_000, keepRecentTokens: 10 },
			}),
			catalog: [scriptedCatalogEntry(1_000_000)],
		})

		yield* session.send('override topic one')
		const finished = yield* session.send('override topic two')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')
		expect(compactionEntries(entries)).toHaveLength(1)
		expect(yield* scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

it.effect('a resumed log projects the compacted history: summary plus post-cut messages only', () =>
	Effect.gen(function* () {
		const logContext = yield* Layer.build(layerInMemoryEventLog)
		const sharedLog: EventLogService = Context.get(logContext, EventLog)

		// Session A compacts, answers, and closes.
		yield* Effect.scoped(
			Effect.gen(function* () {
				const { model } = yield* scriptedModel(gptActiveModel, [
					textTurn(`noted ${'v'.repeat(120)}`, hugeUsage),
					textTurn('## Goal\n- durable summary'),
					textTurn('answer two'),
				])
				const session = yield* startSession({
					agent: defineAgent({ model, systemPrompt: 'Assistant.', autoCompact: compactConfig }),
					log: eventLogSource(Effect.succeed(sharedLog)),
				})
				yield* session.send('the secret phrase is xyzzy')
				const finished = yield* session.send('next')
				expect(finished.outcome).toBe('completed')
			}),
		)

		// Session B adopts the same log with the same configuration: replay rebuilds the compacted
		// projection - the durable summary and the kept tail, not the replaced history.
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [textTurn('resumed answer')])
		const session = yield* resumeSession({
			agent: defineAgent({ model, systemPrompt: 'Assistant.', autoCompact: compactConfig }),
			log: eventLogSource(Effect.succeed(sharedLog)),
		})

		const finished = yield* session.send('continue')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('resumed answer')
		expect(compactionEntries(entries)).toHaveLength(1)

		const resumedRequest = JSON.stringify((yield* scripted.prompts)[0])
		expect(resumedRequest).toContain('durable summary')
		expect(resumedRequest).toContain('answer two')
		expect(resumedRequest).toContain('continue')
		expect(resumedRequest).not.toContain('secret phrase is xyzzy')
	}).pipe(Effect.scoped),
)
