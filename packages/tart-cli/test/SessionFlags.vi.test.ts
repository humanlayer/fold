/**
 * `sessionOptionsFromFlags` lowering: the `--mode` choice reaches `CliSessionOptions.mode` (and is
 * absent when the flag is), alongside the existing resume/model-selection folding.
 */
import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import { sessionOptionsFromFlags, type CommonFlagValues } from '../src/index'

const baseFlags: CommonFlagValues = {
	prompt: Option.none(),
	resume: Option.none(),
	provider: Option.none(),
	model: Option.none(),
	role: Option.none(),
	mode: Option.none(),
	reasoning: Option.none(),
	cwd: Option.some('/tmp/project'),
	tartHome: Option.none(),
	noColor: false,
	verbose: false,
	autoCompact: false,
	disableAutoCompact: false,
	compactionThreshold: Option.none(),
	compactionReserveTokens: Option.none(),
	compactionKeepRecentTokens: Option.none(),
	compactionPrompt: Option.none(),
}

it.effect('lowers --mode into the session options', () =>
	Effect.gen(function* () {
		const options = yield* sessionOptionsFromFlags({ ...baseFlags, mode: Option.some('rlm') })

		expect(options.mode).toBe('rlm')
		expect(options.cwd).toBe('/tmp/project')
	}),
)

it.effect('omits mode when the flag is absent', () =>
	Effect.gen(function* () {
		const options = yield* sessionOptionsFromFlags(baseFlags)

		expect('mode' in options).toBe(false)
	}),
)

it.effect('lowers --mode default as an explicit mode selection', () =>
	Effect.gen(function* () {
		const options = yield* sessionOptionsFromFlags({ ...baseFlags, mode: Option.some('default') })

		expect(options.mode).toBe('default')
	}),
)
