import { existsSync, utimesSync } from 'node:fs'

import { expect, it } from '@effect/vitest'
import { SessionId, ToolCallId } from '@humanlayer/tart-core'
import { Effect } from 'effect'

import { makeOutputStore, toolOutputPathFor } from '../../src/OutputStore/OutputStore'
import { tempDir } from '../TestHelpers'

it.effect('stores tool output at a deterministic session/tool-call path', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const sessionId = SessionId.make('sess_aaaaaaaaaaaaaaaaaaaaaaaa')
		const toolCallId = ToolCallId.make('tool_call_bbbbbbbbbbbbbbbbbbbbbbbb')
		const store = makeOutputStore({ sessionId, tartHome: root })
		const expectedPath = toolOutputPathFor({ sessionId, toolCallId, tartHome: root })

		const first = yield* store.append(toolCallId, 'one\n')
		const second = yield* store.append(toolCallId, 'two\nthree')

		expect(first.path).toBe(expectedPath)
		expect(second.path).toBe(expectedPath)
		expect(yield* store.read(first)).toBe('one\ntwo\nthree')
		expect(yield* store.read(first, { offset: 2, limit: 1 })).toBe('two')
	}),
)

it.live('sweeps old stored output files best-effort', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const sessionId = SessionId.make('sess_cccccccccccccccccccccccc')
		const toolCallId = ToolCallId.make('tool_call_dddddddddddddddddddddddd')
		const store = makeOutputStore({ sessionId, tartHome: root, retentionMs: 1 })

		const ref = yield* store.append(toolCallId, 'old output')
		const old = new Date(0)
		utimesSync(ref.path, old, old)
		expect(yield* store.read(ref)).toBe('old output')

		yield* store.sweep
		expect(existsSync(ref.path)).toBe(false)
	}),
)
