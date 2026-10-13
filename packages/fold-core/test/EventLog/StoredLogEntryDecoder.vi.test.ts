import { it, expect } from '@effect/vitest'
import { Effect, Predicate } from 'effect'

import {
	AgentId,
	CURRENT_LOG_ENTRY_VERSION,
	EventId,
	EventLogUnsupportedVersionError,
	MessageId,
	SessionId,
	SUPPORTED_LOG_ENTRY_VERSIONS,
	ToolCallId,
	decodeStoredLogEntry,
} from '../../src/index'

type SessionStartedEntryBuilder = {
	_tag: 'session_started'
	seq: number
	eventId: ReturnType<typeof EventId.create>
	ts: number
	version?: number
	agentId: null
	parentAgentId: null
	toolCallId: null
	cwd: string
	sessionId: ReturnType<typeof SessionId.create>
	rootAgentId: ReturnType<typeof AgentId.create>
	meta: Record<string, never>
}

const sessionStartedEntry = (version?: number) => {
	const entry: SessionStartedEntryBuilder = {
		_tag: 'session_started',
		seq: 0,
		eventId: EventId.create(),
		ts: 1,
		agentId: null,
		parentAgentId: null,
		toolCallId: null,
		cwd: '/tmp/fold',
		sessionId: SessionId.create(),
		rootAgentId: AgentId.create(),
		meta: {},
	}
	if (version !== undefined) {
		entry.version = version
	}

	return entry
}

const legacySessionTitleEntry = () => ({
	_tag: 'session_title',
	seq: 1,
	eventId: EventId.create(),
	ts: 2,
	agentId: null,
	parentAgentId: null,
	toolCallId: null,
	title: 'Legacy session',
})

it.effect('decodes the current persisted event format', () =>
	Effect.gen(function* () {
		const entry = yield* decodeStoredLogEntry(sessionStartedEntry(CURRENT_LOG_ENTRY_VERSION))

		expect(entry.version).toBe(CURRENT_LOG_ENTRY_VERSION)
		expect(SUPPORTED_LOG_ENTRY_VERSIONS).toEqual([CURRENT_LOG_ENTRY_VERSION])
	}),
)

it.effect('upcasts entries written before per-entry versioning to v1', () =>
	Effect.gen(function* () {
		const entry = yield* decodeStoredLogEntry(legacySessionTitleEntry())

		expect(entry.version).toBe(1)
		expect(entry._tag).toBe('session_title')
	}),
)

it.effect('decodes existing OpenAI agent entries without reasoning summary configuration', () =>
	Effect.gen(function* () {
		const entry = yield* decodeStoredLogEntry({
			_tag: 'agent_started',
			version: CURRENT_LOG_ENTRY_VERSION,
			seq: 1,
			eventId: EventId.create(),
			ts: 2,
			agentId: AgentId.create(),
			parentAgentId: null,
			toolCallId: null,
			mode: 'fresh',
			model: {
				providerId: 'openai',
				providerKind: 'openai-compatible',
				modelId: 'gpt-5.5',
				role: null,
				requestedReasoningLevel: 'medium',
				reasoning: { _tag: 'effort', effort: 'medium' },
			},
			tools: [],
			skill: null,
			fork: null,
			agentType: null,
		})

		expect(entry._tag).toBe('agent_started')
		if (!Predicate.isTagged(entry, 'agent_started')) return
		expect(entry.model.providerKind).toBe('openai-compatible')
		if (entry.model.providerKind !== 'openai-compatible') return
		expect(entry.model.reasoningSummary).toBeUndefined()
	}),
)

it.effect('rejects an unsupported event format without guessing its schema', () =>
	Effect.gen(function* () {
		const error = yield* decodeStoredLogEntry(sessionStartedEntry(2)).pipe(Effect.flip)

		expect(error).toBeInstanceOf(EventLogUnsupportedVersionError)
		if (Predicate.isTagged(error, 'EventLogUnsupportedVersionError')) {
			expect(error.version).toBe(2)
			expect(error.seq).toBe(0)
			expect(error.supportedVersions).toEqual([1])
		}
	}),
)

const legacyUserMessageEntry = () => ({
	_tag: 'user-message',
	seq: 2,
	eventId: EventId.create(),
	ts: 3,
	agentId: AgentId.create(),
	parentAgentId: null,
	toolCallId: null,
	messageId: MessageId.create(),
	message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
})

it.effect('decodes v1 user messages written before message origins existed', () =>
	Effect.gen(function* () {
		const entry = yield* decodeStoredLogEntry(legacyUserMessageEntry())

		expect(entry._tag).toBe('user-message')
		if (!Predicate.isTagged(entry, 'user-message')) throw new Error('expected a user-message')
		expect(entry.origin).toBeUndefined()
	}),
)

it.effect('decodes task-notification origins and background task lifecycle rows', () =>
	Effect.gen(function* () {
		const taskId = AgentId.create()
		const parentAgentId = AgentId.create()
		const toolCallId = ToolCallId.create()

		const notification = yield* decodeStoredLogEntry({
			...legacyUserMessageEntry(),
			version: CURRENT_LOG_ENTRY_VERSION,
			origin: { _tag: 'task-notification', taskIds: [taskId] },
		})
		if (!Predicate.isTagged(notification, 'user-message')) throw new Error('expected a user-message')
		expect(notification.origin).toEqual({ _tag: 'task-notification', taskIds: [taskId] })

		const started = yield* decodeStoredLogEntry({
			_tag: 'task_started',
			seq: 3,
			eventId: EventId.create(),
			ts: 4,
			version: CURRENT_LOG_ENTRY_VERSION,
			agentId: taskId,
			parentAgentId,
			toolCallId,
			taskType: 'subagent',
			agentType: 'researcher',
			description: 'find it',
			prompt: 'look',
			isBackgrounded: true,
			runCount: 1,
		})
		expect(started._tag).toBe('task_started')

		const finished = yield* decodeStoredLogEntry({
			_tag: 'task_finished',
			seq: 4,
			eventId: EventId.create(),
			ts: 5,
			agentId: taskId,
			parentAgentId,
			toolCallId,
			status: 'completed',
			summary: 'found it',
			error: null,
			usage: { turns: 1, toolUses: 2, totalTokens: null },
			durationMs: 10,
			lastToolName: 'read',
		})
		expect(finished._tag).toBe('task_finished')
		expect(finished.version).toBe(1)
	}),
)
