import { it, expect } from '@effect/vitest'
import { Effect, Predicate } from 'effect'

import {
	AgentId,
	CURRENT_LOG_ENTRY_VERSION,
	EventId,
	EventLogUnsupportedVersionError,
	SessionId,
	SUPPORTED_LOG_ENTRY_VERSIONS,
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
