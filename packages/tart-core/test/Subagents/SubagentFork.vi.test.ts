/**
 * Engine tests for fork mode (D21): the fork clones the caller - model binding, toolset, and, through
 * fork-by-reference projection, its full history up to the observed head - with NO new leading system
 * message, so the fork's prompt prefix is byte-identical to the caller's (the provider-cache claim,
 * asserted for real against the scripted model's recorded prompts).
 */
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import type { AgentStartedLogEntry, AssistantMessageLogEntry } from '../../src/index'
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel'
import { makeDriveSession, renderedDriveResult, subagentStartedEntries } from './DriveHarness'

it.effect('a fork clones the caller: shared history prefix, no new leading prompt, own rows after', () =>
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
		// (the caller's assistant tool-call row, appended just before settlement began).
		expect(forkStarted.mode).toBe('fork')
		expect(forkStarted.agentType).toBeNull()
		const rootStarted = entries.find(
			(entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started' && entry.parentAgentId === null,
		)
		if (rootStarted === undefined) throw new Error('expected the root agent_started')
		expect(forkStarted.fork?.fromAgentId).toBe(rootStarted.agentId)
		const dispatchingAssistantRow = entries.find(
			(entry): entry is AssistantMessageLogEntry =>
				entry._tag === 'assistant-message' && entry.agentId === rootStarted.agentId,
		)
		expect(forkStarted.fork?.atSeq).toBe(dispatchingAssistantRow?.seq)

		// No new leading system message for the fork: the fold carries the caller's blocks.
		const forkSystemMessages = entries.filter(
			(entry) => entry._tag === 'system-message' && entry.agentId === forkStarted.agentId,
		)
		expect(forkSystemMessages).toHaveLength(0)

		// The cache claim, for real: the fork's first request begins with the caller's first request,
		// byte for byte, then continues with the caller's tool-call turn and the fork prompt.
		const prompts = yield* rootScripted.scripted.prompts
		const callerRequest = prompts[0]
		const forkRequest = prompts[1]
		if (callerRequest === undefined || forkRequest === undefined) throw new Error('expected two requests')
		const prefix = forkRequest.content.slice(0, callerRequest.content.length)
		expect(JSON.stringify(prefix)).toBe(JSON.stringify(callerRequest.content))
		expect(JSON.stringify(forkRequest.content.slice(callerRequest.content.length))).toContain(
			'continue with everything you know',
		)

		// The result renders like any dispatch: resumable id + turns header + body.
		const rendered = renderedDriveResult(entries, 0)
		expect(rendered).toContain(`agent_id: ${forkStarted.agentId}`)
		expect(rendered).toContain('turns: 1 this run (1 total)')
		expect(rendered).toContain('fork findings')
	}).pipe(Effect.scoped),
)
