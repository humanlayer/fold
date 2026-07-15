import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import {
	Session,
	SessionAlreadyStartedError,
	SessionNotStartedError,
	type AgentStartedLogEntry,
	type SessionStartedLogEntry,
} from '../../src/index'
import { makeScriptedLanguageModel, textTurn } from '../TestLayers/ScriptedLanguageModel'
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { collectEntries } from '../ToolRuntime/ToolRuntimeTestHelpers'
import { sessionBaseLayer, startSessionInput } from './SessionTestHelpers'

it.effect('starts a session and completes a text-only send with the full log shape', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const scripted = yield* makeScriptedLanguageModel([textTurn('Hello!')])
		const layer = sessionBaseLayer(scripted.layer, layerEchoTool(recorder))

		const result = yield* Effect.gen(function* () {
			const session = yield* Session

			const started = yield* session.start(startSessionInput())
			const finished = yield* session.send({ text: 'hi there' })
			const entries = yield* collectEntries

			return { started, finished, entries }
		}).pipe(Effect.provide(layer))

		expect(result.started.sessionId.startsWith('sess_')).toBe(true)
		expect(result.started.rootAgentId.startsWith('agent_')).toBe(true)

		expect(result.finished.outcome).toBe('completed')
		expect(result.finished.resultText).toBe('Hello!')

		expect(result.entries.map((entry) => entry._tag)).toEqual([
			'session_started',
			'agent_started',
			'system-message',
			'user-message',
			'assistant-message',
			'agent-finished',
		])

		const sessionStarted = result.entries.find(
			(entry): entry is SessionStartedLogEntry => entry._tag === 'session_started',
		)
		expect(sessionStarted?.seq).toBe(0)
		expect(sessionStarted?.sessionId).toBe(result.started.sessionId)
		expect(sessionStarted?.rootAgentId).toBe(result.started.rootAgentId)
		expect(sessionStarted?.cwd).toBe('/test')
		expect(sessionStarted?.version).toBe(1)

		const agentStarted = result.entries.find(
			(entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started',
		)
		expect(agentStarted?.agentId).toBe(result.started.rootAgentId)
	}),
)

it.effect('records a null cwd when the host has none', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const scripted = yield* makeScriptedLanguageModel([textTurn('Hello!')])
		const layer = sessionBaseLayer(scripted.layer, layerEchoTool(recorder))

		const entries = yield* Effect.gen(function* () {
			const session = yield* Session

			yield* session.start(startSessionInput({ cwd: null }))
			return yield* collectEntries
		}).pipe(Effect.provide(layer))

		const sessionStarted = entries.find(
			(entry): entry is SessionStartedLogEntry => entry._tag === 'session_started',
		)
		expect(sessionStarted?.cwd).toBeNull()
	}),
)

it.effect('fails send before start with SessionNotStartedError', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const scripted = yield* makeScriptedLanguageModel([textTurn('Hello!')])
		const layer = sessionBaseLayer(scripted.layer, layerEchoTool(recorder))

		const error = yield* Effect.gen(function* () {
			const session = yield* Session

			return yield* session.send({ text: 'hi there' }).pipe(Effect.flip)
		}).pipe(Effect.provide(layer))

		expect(error).toBeInstanceOf(SessionNotStartedError)
	}),
)

it.effect('fails a second start with SessionAlreadyStartedError and appends no second session_started', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const scripted = yield* makeScriptedLanguageModel([textTurn('Hello!')])
		const layer = sessionBaseLayer(scripted.layer, layerEchoTool(recorder))

		const result = yield* Effect.gen(function* () {
			const session = yield* Session

			yield* session.start(startSessionInput())
			const error = yield* session.start(startSessionInput()).pipe(Effect.flip)
			const entries = yield* collectEntries

			return { error, entries }
		}).pipe(Effect.provide(layer))

		expect(result.error).toBeInstanceOf(SessionAlreadyStartedError)
		expect(result.entries.filter((entry) => entry._tag === 'session_started')).toHaveLength(1)
	}),
)
