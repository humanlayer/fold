/**
 * Engine tests for fork mode (D21): the fork clones the caller's model binding and toolset, and inherits
 * only completed conversation history. It omits the active parent tool-call turn because its result is
 * the child run itself, so including it would create an invalid provider request.
 */
import { expect, it } from '@effect/vitest'
import { Predicate, Effect } from 'effect'

import { shortAgentId, type AgentStartedLogEntry, type AssistantMessageLogEntry } from '../../src/index'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { makeDriveSession, renderedDriveResult, subagentStartedEntries } from './DriveHarness'

it.effect('a fork inherits completed context without its invoking tool call', () =>
	Effect.gen(function* () {
		// The fork clones the ROOT, so it runs on the root's scripted model: turn 1 is the root's drive
		// call, turn 2 is consumed by the fork, turn 3 finishes the root.
		const { session, drive, rootScripted } = yield* makeDriveSession({
			definitions: [],
			rootTurns: 0,
			rootScript: [
				toolCallTurn([{ id: 'provider-call-0', name: 'drive', params: {} }]),
				textTurn('fork findings'),
				textTurn('root done'),
			],
		})

		const finished = yield* drive({ op: 'fork', prompt: 'continue with everything you know' })
		expect(finished.outcome).toBe('completed')

		const entries = yield* session.entries
		const forkStarted = subagentStartedEntries(entries)[0]
		if (forkStarted === undefined) throw new Error('expected the fork to have started')

		// Fork provenance: mode, no agentType, fromAgentId = the caller, atSeq = the observed head
		// (the caller's assistant tool-call row, appended just before settlement began). This direct
		// engine call leaves `history` absent to cover legacy persisted forks, which also use the
		// completed-history default.
		expect(forkStarted.mode).toBe('fork')
		expect(forkStarted.agentType).toBeNull()
		const rootStarted = entries.find(
			(entry): entry is AgentStartedLogEntry =>
				Predicate.isTagged(entry, 'agent_started') && entry.parentAgentId === null,
		)
		if (rootStarted === undefined) throw new Error('expected the root agent_started')
		expect(forkStarted.fork?.fromAgentId).toBe(rootStarted.agentId)
		const dispatchingAssistantRow = entries.find(
			(entry): entry is AssistantMessageLogEntry =>
				Predicate.isTagged(entry, 'assistant-message') && entry.agentId === rootStarted.agentId,
		)
		expect(forkStarted.fork?.atSeq).toBe(dispatchingAssistantRow?.seq)
		expect(forkStarted.fork?.history).toBeUndefined()

		// No new leading system message for the fork: the fold carries the caller's blocks.
		const forkSystemMessages = entries.filter(
			(entry) => Predicate.isTagged(entry, 'system-message') && entry.agentId === forkStarted.agentId,
		)
		expect(forkSystemMessages).toHaveLength(0)

		// The fork carries no new leading system message, but its first request omits the parent user turn
		// and assistant tool-call turn that invoked it. This prevents a provider request from containing a
		// function call whose output cannot exist until the child completes.
		const prompts = yield* rootScripted.scripted.prompts
		const forkRequest = prompts[1]
		if (forkRequest === undefined) throw new Error('expected fork request')
		expect(JSON.stringify(forkRequest.content)).toContain('continue with everything you know')
		expect(JSON.stringify(forkRequest.content)).not.toContain('provider-call-0')
		expect(JSON.stringify(forkRequest.content)).not.toContain('go')

		// The result renders like any dispatch: resumable id + turns header + body.
		const rendered = renderedDriveResult(entries, 0)
		expect(rendered).toContain(`agent_id: ${shortAgentId(forkStarted.agentId)}`)
		expect(rendered).toContain('turns: 1 this run (1 total)')
		expect(rendered).toContain('fork findings')
	}).pipe(Effect.scoped),
)
