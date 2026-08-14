import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { it, expect } from '@effect/vitest'
import {
	AgentId,
	EventId,
	EventLog,
	EventLogCorruptEntryError,
	MessageId,
	SessionId,
	StateId,
	type LogEntryInput,
} from '@humanlayer/fold-core'
import { Effect, Fiber, FileSystem, Stream } from 'effect'

import { layerJsonl } from '../../src/index'

const makeSessionStarted = (cwd: string): LogEntryInput => ({
	_tag: 'session_started',
	agentId: null,
	parentAgentId: null,
	toolCallId: null,
	version: 1,
	cwd,
	sessionId: SessionId.create(),
	rootAgentId: AgentId.create(),
	meta: {},
})

const makeToolState = (value: unknown): LogEntryInput => ({
	_tag: 'tool_state',
	agentId: AgentId.create(),
	parentAgentId: null,
	toolCallId: null,
	namespace: 'guard',
	stateId: StateId.create(),
	key: 'count',
	value,
})

it.effect('jsonl layer writes one entry per line and reopens existing logs', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-event-log-' })
			const filePath = join(dir, 'session.jsonl')

			const firstRead = yield* Effect.gen(function* () {
				const log = yield* EventLog
				yield* log.append(makeSessionStarted('/tmp/one'))
				yield* log.append(makeSessionStarted('/tmp/two'))
				yield* log.append(makeToolState(41))

				return yield* Stream.runCollect(log.entries())
			}).pipe(Effect.provide(layerJsonl(filePath)))

			const contents = yield* fs.readFileString(filePath)
			const lines = contents.split('\n').filter((line) => line.length > 0)
			const reopenedRead = yield* Effect.gen(function* () {
				const log = yield* EventLog
				return yield* Stream.runCollect(log.entries(1))
			}).pipe(Effect.provide(layerJsonl(filePath)))

			expect(firstRead.map((entry) => entry.seq)).toEqual([0, 1, 2])
			expect(firstRead.every((entry) => EventId.is(entry.eventId))).toBe(true)
			expect(new Set(firstRead.map((entry) => entry.eventId)).size).toBe(3)
			expect(lines).toHaveLength(3)
			expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
				_tag: 'session_started',
				seq: 0,
				eventId: firstRead[0]?.eventId,
			})
			expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({
				_tag: 'session_started',
				seq: 1,
				eventId: firstRead[1]?.eventId,
			})
			expect(JSON.parse(lines[2] ?? '{}')).toMatchObject({
				_tag: 'tool_state',
				seq: 2,
				eventId: firstRead[2]?.eventId,
				namespace: 'guard',
				key: 'count',
				value: 41,
				toolCallId: null,
			})
			expect(reopenedRead.map((entry) => entry.seq)).toEqual([1, 2])
			expect(reopenedRead.map((entry) => entry.eventId)).toEqual(firstRead.slice(1).map((entry) => entry.eventId))
		}),
	).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('jsonl layer maps invalid persisted lines to EventLogCorruptEntryError', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-event-log-' })
			const filePath = join(dir, 'corrupt.jsonl')

			yield* fs.writeFileString(filePath, '{not json}\n')

			const error = yield* Effect.gen(function* () {
				const log = yield* EventLog
				return yield* Stream.runCollect(log.entries())
			}).pipe(Effect.provide(layerJsonl(filePath)), Effect.flip)

			if (!(error instanceof EventLogCorruptEntryError)) {
				throw new Error(`expected EventLogCorruptEntryError, got ${error._tag}`)
			}
			expect(error.line).toBe(1)
		}),
	).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('jsonl layer rejects invalid persisted event IDs', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-event-log-' })
			const filePath = join(dir, 'invalid-event-id.jsonl')

			yield* fs.writeFileString(
				filePath,
				`${JSON.stringify({ ...makeSessionStarted('/tmp/invalid-event-id'), seq: 0, eventId: null, ts: 1 })}\n`,
			)

			const error = yield* Effect.gen(function* () {
				const log = yield* EventLog
				return yield* Stream.runCollect(log.entries())
			}).pipe(Effect.provide(layerJsonl(filePath)), Effect.flip)

			expect(error).toBeInstanceOf(EventLogCorruptEntryError)
		}),
	).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('jsonl layer assigns stable event IDs when replaying legacy rows', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-event-log-' })
			const filePath = join(dir, 'legacy.jsonl')
			const legacyEntry = {
				_tag: 'session_started',
				seq: 0,
				ts: 1,
				agentId: null,
				parentAgentId: null,
				toolCallId: null,
				version: 1,
				cwd: '/tmp/legacy',
				sessionId: SessionId.create(),
				rootAgentId: AgentId.create(),
				meta: {},
			}
			const legacyLine = JSON.stringify(legacyEntry)

			yield* fs.writeFileString(filePath, [legacyLine, ''].join('\n'))
			const firstRead = yield* Effect.gen(function* () {
				const log = yield* EventLog
				return yield* Stream.runCollect(log.entries())
			}).pipe(Effect.provide(layerJsonl(filePath)))
			const reopenedRead = yield* Effect.gen(function* () {
				const log = yield* EventLog
				return yield* Stream.runCollect(log.entries())
			}).pipe(Effect.provide(layerJsonl(filePath)))

			const firstEventId = firstRead[0]?.eventId
			expect(firstEventId).toBeDefined()
			expect(EventId.is(firstEventId ?? '')).toBe(true)
			expect(reopenedRead[0]?.eventId).toBe(firstEventId)

			const otherFilePath = join(dir, 'other-legacy.jsonl')
			yield* fs.writeFileString(
				otherFilePath,
				`${JSON.stringify({ ...legacyEntry, sessionId: SessionId.create(), rootAgentId: AgentId.create() })}\n`,
			)
			const otherRead = yield* Effect.gen(function* () {
				const log = yield* EventLog
				return yield* Stream.runCollect(log.entries())
			}).pipe(Effect.provide(layerJsonl(otherFilePath)))

			expect(otherRead[0]?.eventId).not.toBe(firstEventId)
		}),
	).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('jsonl layer replays assistant usage when cache fields are absent', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-event-log-' })
			const filePath = join(dir, 'usage.jsonl')
			const agentId = AgentId.create()
			const line = JSON.stringify({
				_tag: 'assistant-message',
				seq: 0,
				eventId: EventId.create(),
				ts: 1,
				agentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: MessageId.create(),
				message: { options: {}, role: 'assistant', content: 'done' },
				finish: {
					reason: 'stop',
					usage: {
						inputTokens: { uncached: 10, total: 10, cacheRead: 0 },
						outputTokens: { total: 2 },
					},
				},
			})

			yield* fs.writeFileString(filePath, `${line}\n`)

			const entries = yield* Effect.gen(function* () {
				const log = yield* EventLog
				return yield* Stream.runCollect(log.entries())
			}).pipe(Effect.provide(layerJsonl(filePath)))
			const entry = entries[0]

			expect(entry?._tag).toBe('assistant-message')
			if (entry?._tag !== 'assistant-message') return
			expect(entry.finish?.usage.inputTokens?.cacheWrite).toBeUndefined()
			expect(entry.finish?.usage.inputTokens?.cacheRead).toBe(0)
			expect(entry.finish?.usage.outputTokens?.total).toBe(2)
		}),
	).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('jsonl subscribe replays and follows live appends', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-event-log-' })
			const filePath = join(dir, 'subscribe.jsonl')

			const result = yield* Effect.gen(function* () {
				const log = yield* EventLog
				yield* log.append(makeSessionStarted('/tmp/one'))

				const fiber = yield* Stream.runCollect(log.subscribe(0).pipe(Stream.take(2))).pipe(Effect.forkChild)
				yield* log.append(makeSessionStarted('/tmp/two'))

				return yield* Fiber.join(fiber)
			}).pipe(Effect.provide(layerJsonl(filePath)))

			expect(result.map((entry) => entry.seq)).toEqual([0, 1])
		}),
	).pipe(Effect.provide(NodeFileSystem.layer)),
)
