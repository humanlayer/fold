/**
 * Facade tests: startSession lowers agent/log/model descriptors into the full runtime graph. Real
 * EventLog, projections, hook runner, tool runtime, and session facade run under scripted language
 * models - only descriptors appear in test setup, mirroring how SDK callers use the API. Model and
 * configuration switching is covered separately in SwitchModel.vi.test.ts, cross-session isolation in
 * SessionIsolation.vi.test.ts.
 */
import { expect, it } from '@effect/vitest'
import { Context, Effect, Fiber, Layer, Schema, Stream } from 'effect'

import {
	defineAgent,
	defineTool,
	defineToolState,
	eventLogSource,
	startSession,
	EventLog,
	layerInMemoryEventLog,
	ToolEvents,
	type AgentStartedLogEntry,
	type HookConfig,
	type PreToolUseHookDecision,
	type SessionStartedLogEntry,
	type ToolResultLogEntry,
	type ToolStateLogEntry,
} from '../../src/index'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { echoTool, gptActiveModel, makeRecordedTool, scriptedModel } from './ApiTestHelpers'

/** The encoded tool-result content part of the first durable tool-result entry. */
const firstToolResultPart = (entries: ReadonlyArray<{ readonly _tag: string }>) => {
	const toolResult = entries.find((entry): entry is ToolResultLogEntry => entry._tag === 'tool-result')
	if (toolResult === undefined) throw new Error('expected a tool-result entry')

	const part = toolResult.message.content[0]
	if (part === undefined || part.type !== 'tool-result') throw new Error('expected a tool-result content part')

	return part
}

it.effect('runs a tool-calling turn end to end from descriptors only', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([{ id: 'provider-call-1', name: 'echo', params: { text: 'hello facade' } }]),
			textTurn('The tool echoed: hello facade'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				name: 'facade-demo',
				model,
				systemPrompt: 'You are a test agent.',
				tools: [echoTool],
			}),
			cwd: '/tmp/facade-demo',
			meta: { suite: 'facade' },
		})

		const finished = yield* session.send('echo something')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('The tool echoed: hello facade')

		expect(entries.map((entry) => entry._tag)).toEqual([
			'session_started',
			'agent_started',
			'system-message',
			'user-message',
			'assistant-message',
			'tool-result',
			'assistant-message',
			'agent-finished',
		])

		const sessionStarted = entries.find(
			(entry): entry is SessionStartedLogEntry => entry._tag === 'session_started',
		)
		expect(sessionStarted?.sessionId).toBe(session.sessionId)
		expect(sessionStarted?.cwd).toBe('/tmp/facade-demo')
		expect(sessionStarted?.meta['suite']).toBe('facade')
		expect(sessionStarted?.meta['agentName']).toBe('facade-demo')

		const agentStarted = entries.find((entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started')
		expect(agentStarted?.agentId).toBe(session.rootAgentId)
		expect(agentStarted?.tools).toEqual(['echo'])

		const resultPart = firstToolResultPart(entries)
		expect(resultPart.isFailure).toBe(false)
		expect(resultPart.result).toEqual({ echoed: 'hello facade' })

		expect(yield* scripted.remainingTurns).toBe(0)
	}).pipe(Effect.scoped),
)

it.effect('runs a tool-free agent with defaults (memory log, no tools, no failure schema)', () =>
	Effect.gen(function* () {
		const { model, scripted } = yield* scriptedModel(gptActiveModel, [textTurn('Just text.')])

		const session = yield* startSession({ agent: defineAgent({ model }) })

		const finished = yield* session.send('hi')
		const requests = yield* scripted.requests

		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('Just text.')
		expect(requests).toHaveLength(1)
		expect(requests[0]?.toolNames).toEqual([])
	}).pipe(Effect.scoped),
)

it.effect('injects a skill as a linked synthetic tool call and result without a user message', () =>
	Effect.gen(function* () {
		const { model } = yield* scriptedModel(gptActiveModel, [])
		const session = yield* startSession({ agent: defineAgent({ model }) })

		const injected = yield* session.injectSkill('terminal-control', '<skill>terminal instructions</skill>')
		const entries = yield* session.entries
		const callPart =
			typeof injected.call.message.content === 'string' ? undefined : injected.call.message.content[0]
		const resultPart = injected.result.message.content[0]
		if (callPart?.type !== 'tool-call') throw new Error('expected injected skill tool call')
		if (resultPart?.type !== 'tool-result') throw new Error('expected injected skill tool result')

		expect(entries.some((entry) => entry._tag === 'user-message')).toBe(false)
		expect(callPart).toMatchObject({
			type: 'tool-call',
			name: 'skill',
			params: { name: 'terminal-control' },
		})
		expect(resultPart).toMatchObject({
			type: 'tool-result',
			name: 'skill',
			result: { content: '<skill>terminal instructions</skill>' },
			isFailure: false,
		})
		expect(callPart.id).toBe(injected.result.toolCallId)
		expect(resultPart.id).toBe(injected.result.toolCallId)
		expect(injected.call.agentId).toBe(session.rootAgentId)
		expect(injected.result.agentId).toBe(session.rootAgentId)
	}).pipe(Effect.scoped),
)

// ── Ambient tool services and the merged event stream ───────────────────────

const ProgressState = defineToolState({
	namespace: 'progress-echo',
	keys: { last: Schema.String },
})

it.effect('tool handlers reach ToolState and ToolEvents; session.events carries rows, text deltas, and progress', () =>
	Effect.gen(function* () {
		const progressTool = defineTool({
			name: 'echo',
			description: 'Echoes text, reporting progress and recording durable state.',
			parameters: Schema.Struct({ text: Schema.String }),
			success: Schema.Struct({ echoed: Schema.String }),
			handler: ({ text }) =>
				Effect.gen(function* () {
					const events = yield* ToolEvents
					yield* events.emit({ progress: `working:${text}` })
					yield* ProgressState.set('last', text)

					return { echoed: text }
				}),
		})

		const { model } = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([{ id: 'provider-call-1', name: 'echo', params: { text: 'hi' } }]),
			textTurn('Tool said hi'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model, systemPrompt: 'You are a test agent.', tools: [progressTool] }),
		})

		// Subscribe before sending: deltas are live-only (durable rows replay from seq 0 regardless).
		// `startImmediately` + one yield lets the merge's subscription fibers register first.
		const collector = yield* session.events().pipe(
			Stream.takeUntil((event) => event.kind === 'log' && event.entry._tag === 'agent-finished'),
			Stream.runCollect,
			Effect.forkChild({ startImmediately: true }),
		)
		yield* Effect.yieldNow

		const finished = yield* session.send('use the echo tool')
		const collected = yield* Fiber.join(collector)

		expect(finished.resultText).toBe('Tool said hi')

		const logTags = collected.flatMap((event) => (event.kind === 'log' ? [event.entry._tag] : []))
		expect(logTags).toEqual([
			'session_started',
			'agent_started',
			'system-message',
			'user-message',
			'assistant-message',
			'tool_state',
			'tool-result',
			'assistant-message',
			'agent-finished',
		])

		const deltas = collected.flatMap((event) => (event.kind === 'delta' ? [event] : []))
		const progressDeltas = deltas.filter((event) => event.part.type === 'tool-progress')
		expect(progressDeltas).toHaveLength(1)
		expect(progressDeltas[0]?.part).toEqual({
			type: 'tool-progress',
			toolName: 'echo',
			payload: { progress: 'working:hi' },
		})
		expect(progressDeltas[0]?.agentId).toBe(session.rootAgentId)
		expect(deltas.some((event) => event.part.type === 'text-delta')).toBe(true)

		// The handler's ToolState write landed as a durable, namespaced tool_state entry.
		const entries = yield* session.entries
		const stateEntry = entries.find((entry): entry is ToolStateLogEntry => entry._tag === 'tool_state')
		expect(stateEntry?.namespace).toBe('progress-echo')
		expect(stateEntry?.key).toBe('last')
		expect(stateEntry?.value).toBe('hi')
	}).pipe(Effect.scoped),
)

// ── Hooks and typed tool failures ────────────────────────────────────────────

it.effect('agent hooks run in the facade: a preToolUse deny replaces the result and the tool never executes', () =>
	Effect.gen(function* () {
		const recorded = yield* makeRecordedTool('echo')
		const denyEcho: HookConfig = {
			preToolUse: [
				{
					name: 'deny-echo',
					tools: ['echo'],
					handler: (): Effect.Effect<PreToolUseHookDecision> =>
						Effect.succeed({
							_tag: 'replaceResult',
							result: { message: 'denied by policy hook' },
							isFailure: true,
						}),
				},
			],
		}

		const { model } = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([{ id: 'provider-call-1', name: 'echo', params: { text: 'blocked' } }]),
			textTurn('Understood, the tool was denied.'),
		])

		const session = yield* startSession({
			agent: defineAgent({
				model,
				systemPrompt: 'You are a test agent.',
				tools: [recorded.tool],
				hooks: denyEcho,
			}),
		})

		const finished = yield* session.send('try the tool')
		const entries = yield* session.entries

		expect(finished.outcome).toBe('completed')
		expect(yield* recorded.calls).toEqual([])

		const resultPart = firstToolResultPart(entries)
		expect(resultPart.isFailure).toBe(true)
		expect(resultPart.result).toEqual({ message: 'denied by policy hook' })
	}).pipe(Effect.scoped),
)

it.effect('a typed handler failure returns to the model schema-encoded with isFailure', () =>
	Effect.gen(function* () {
		const flakyTool = defineTool({
			name: 'flaky',
			description: 'Always fails with a typed, expected failure.',
			parameters: Schema.Struct({}),
			failure: Schema.Struct({ message: Schema.String }),
			handler: () => Effect.fail({ message: 'expected failure' }),
		})

		const { model } = yield* scriptedModel(gptActiveModel, [
			toolCallTurn([{ id: 'provider-call-1', name: 'flaky', params: {} }]),
			textTurn('The tool failed, moving on.'),
		])

		const session = yield* startSession({
			agent: defineAgent({ model, systemPrompt: 'You are a test agent.', tools: [flakyTool] }),
		})

		const finished = yield* session.send('run the flaky tool')
		const entries = yield* session.entries

		// The failure is a domain value the model sees (failureMode "return"), not a crashed run.
		expect(finished.outcome).toBe('completed')
		expect(finished.resultText).toBe('The tool failed, moving on.')

		const resultPart = firstToolResultPart(entries)
		expect(resultPart.isFailure).toBe(true)
		expect(resultPart.result).toEqual({ message: 'expected failure' })
	}).pipe(Effect.scoped),
)

// ── Log backends and descriptor validation ──────────────────────────────────

it.effect('eventLogSource backs the session with a caller-supplied EventLog service', () =>
	Effect.gen(function* () {
		const external = yield* Layer.build(layerInMemoryEventLog).pipe(
			Effect.map((context) => Context.get(context, EventLog)),
		)
		const { model } = yield* scriptedModel(gptActiveModel, [textTurn('logged externally')])

		const session = yield* startSession({
			agent: defineAgent({ model, systemPrompt: 'You are a test agent.' }),
			log: eventLogSource(Effect.succeed(external)),
		})

		yield* session.send('hi')

		const externalEntries = yield* Stream.runCollect(external.entries())
		expect(externalEntries.map((entry) => entry._tag)).toEqual([
			'session_started',
			'agent_started',
			'system-message',
			'user-message',
			'assistant-message',
			'agent-finished',
		])
	}).pipe(Effect.scoped),
)

it.effect('rejects duplicate tool names as a defect', () =>
	Effect.gen(function* () {
		const { model } = yield* scriptedModel(gptActiveModel, [])

		const exit = yield* startSession({
			agent: defineAgent({ model, tools: [echoTool, echoTool] }),
		}).pipe(Effect.exit)

		expect(exit._tag).toBe('Failure')
		expect(String(exit)).toContain('duplicate tool names: echo')
	}).pipe(Effect.scoped),
)
