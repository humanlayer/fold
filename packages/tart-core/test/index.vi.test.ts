import { it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'

import { LogSeq, ToolCallId } from '../src/index.ts'

it.effect('defines core schemas', () =>
	Effect.gen(function* () {
		const seq = yield* Schema.decodeUnknownEffect(LogSeq)(0)
		const toolCallId = ToolCallId.create()

		expect(seq).toBe(0)
		expect(ToolCallId.is(toolCallId)).toBe(true)
	}),
)
