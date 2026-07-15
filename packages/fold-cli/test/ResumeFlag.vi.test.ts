/**
 * `--resume` parsing: the `latest` sentinel resolves the newest log for the project (D5 discovery), an
 * exact `sess_*` id adopts that log, and anything else fails loudly rather than silently starting a
 * fresh session.
 */
import { expect, it } from '@effect/vitest'
import { SessionId } from '@humanlayer/fold-core'
import { Effect, Exit } from 'effect'

import { parseResumeFlag } from '../src/index'

it.effect('parses the latest sentinel', () =>
	Effect.gen(function* () {
		expect(yield* parseResumeFlag('latest')).toEqual({ _tag: 'latest' })
		expect(yield* parseResumeFlag('  latest  ')).toEqual({ _tag: 'latest' })
	}),
)

it.effect('parses an exact session id', () =>
	Effect.gen(function* () {
		const sessionId = SessionId.make('sess_aaaaaaaaaaaaaaaaaaaaaaaa')
		expect(yield* parseResumeFlag(sessionId)).toEqual({ _tag: 'id', sessionId })
	}),
)

it.effect('fails on anything else instead of falling back to a fresh session', () =>
	Effect.gen(function* () {
		for (const value of ['newest', 'sess_', 'abc123', '']) {
			const exit = yield* Effect.exit(parseResumeFlag(value))
			expect(Exit.isFailure(exit), `expected ${JSON.stringify(value)} to be rejected`).toBe(true)
		}
	}),
)
