import { expect, it } from '@effect/vitest'
import { Effect, Fiber, Stream } from 'effect'

import { AgentEvents, AgentRuntime } from '../../src/index'
import { finishPart, makeScriptedLanguageModel, rawTurn } from '../TestLayers/ScriptedLanguageModel'
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { collectEntries } from '../ToolRuntime/ToolRuntimeTestHelpers'
import { agentId, agentRuntimeBaseLayer, runInput, startInput } from './AgentRuntimeTestHelpers'

const durableTags = ['agent_started', 'system-message', 'user-message', 'assistant-message', 'agent-finished']

it.effect('publishes streamed reasoning/text deltas through AgentEvents without persisting them', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder()
		const scripted = yield* makeScriptedLanguageModel([
			rawTurn([
				{ type: 'reasoning-start', id: 'reasoning-1' },
				{ type: 'reasoning-delta', id: 'reasoning-1', delta: 'thinking...' },
				{ type: 'reasoning-end', id: 'reasoning-1' },
				{ type: 'text-start', id: 'text-1' },
				{ type: 'text-delta', id: 'text-1', delta: 'Hel' },
				{ type: 'text-delta', id: 'text-1', delta: 'lo!' },
				{ type: 'text-end', id: 'text-1' },
				finishPart(),
			]),
		])
		const layer = agentRuntimeBaseLayer(scripted.layer, layerEchoTool(recorder))

		const result = yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime
			const events = yield* AgentEvents

			// Establish the AgentEvents subscription on a child fiber that starts immediately: the PubSub is
			// live-only, so it must register before `run` streams and publishes deltas. `startImmediately` runs the
			// collector until it forks the subscribe fiber and suspends; the single `yieldNow` then lets that fiber
			// register its subscription before `run` publishes. Scheduling is cooperative, so no wall-clock sleep is
			// needed. `start` writes only durable rows and publishes no deltas, so ordering it after the fork is safe.
			const collector = yield* events.subscribe.pipe(
				Stream.filter((event) => event.kind === 'delta'),
				Stream.take(3),
				Stream.runCollect,
				Effect.forkChild({ startImmediately: true }),
			)

			yield* Effect.yieldNow

			yield* runtime.start(startInput())
			const finished = yield* runtime.run(runInput('hi there'))
			const collected = yield* Fiber.join(collector)
			const entries = yield* collectEntries

			return { finished, collected, entries }
		}).pipe(Effect.provide(layer))

		// The run still resolves normally, concatenating the streamed text deltas into the assistant result.
		expect(result.finished.outcome).toBe('completed')
		expect(result.finished.resultText).toBe('Hello!')

		// Deltas arrive live, in stream order: reasoning first, then each text delta.
		const deltas = result.collected.flatMap((event) => (event.kind === 'delta' ? [event] : []))
		expect(deltas.map((delta) => delta.part)).toEqual([
			{ type: 'reasoning-delta', id: 'reasoning-1', delta: 'thinking...' },
			{ type: 'text-delta', id: 'text-1', delta: 'Hel' },
			{ type: 'text-delta', id: 'text-1', delta: 'lo!' },
		])

		// Every delta carries the run's identity.
		for (const delta of deltas) {
			expect(delta.agentId).toBe(agentId)
			expect(delta.parentAgentId).toBe(null)
			expect(delta.toolCallId).toBe(null)
		}

		// Deltas never became durable rows: the log is exactly the five durable tags.
		expect(result.entries.map((entry) => entry._tag)).toEqual(durableTags)
	}),
)
