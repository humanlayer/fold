import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { it, expect } from '@effect/vitest'
import { AgentId, EventLog, EventLogCorruptEntryError, SessionId, type LogEntryInput } from '@humanlayer/tart-core'
import { Effect, Fiber, FileSystem, Stream } from 'effect'

import { layerJsonl } from '../../src/index.ts'

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

it.effect('jsonl layer writes one entry per line and reopens existing logs', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'tart-event-log-' })
			const filePath = join(dir, 'session.jsonl')

			const firstRead = yield* Effect.gen(function* () {
				const log = yield* EventLog
				yield* log.append(makeSessionStarted('/tmp/one'))
				yield* log.append(makeSessionStarted('/tmp/two'))

				return yield* Stream.runCollect(log.entries())
			}).pipe(Effect.provide(layerJsonl(filePath)))

			const contents = yield* fs.readFileString(filePath)
			const lines = contents.split('\n').filter((line) => line.length > 0)
			const reopenedRead = yield* Effect.gen(function* () {
				const log = yield* EventLog
				return yield* Stream.runCollect(log.entries(1))
			}).pipe(Effect.provide(layerJsonl(filePath)))

			expect(firstRead.map((entry) => entry.seq)).toEqual([0, 1])
			expect(lines).toHaveLength(2)
			expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ _tag: 'session_started', seq: 0 })
			expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ _tag: 'session_started', seq: 1 })
			expect(reopenedRead.map((entry) => entry.seq)).toEqual([1])
		}),
	).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('jsonl layer maps invalid persisted lines to EventLogCorruptEntryError', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'tart-event-log-' })
			const filePath = join(dir, 'corrupt.jsonl')

			yield* fs.writeFileString(filePath, '{not json}\n')

			const error = yield* Effect.gen(function* () {
				const log = yield* EventLog
				return yield* Stream.runCollect(log.entries())
			}).pipe(Effect.provide(layerJsonl(filePath)), Effect.flip)

			expect(error).toBeInstanceOf(EventLogCorruptEntryError)
			expect((error as EventLogCorruptEntryError).line).toBe(1)
		}),
	).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('jsonl subscribe replays and follows live appends', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'tart-event-log-' })
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
