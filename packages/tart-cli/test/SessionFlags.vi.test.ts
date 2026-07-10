/**
 * `sessionOptionsFromFlags` lowering: the `--mode` choice reaches `CliSessionOptions.mode` (and is
 * absent when the flag is), alongside the existing resume/model-selection folding.
 */
import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import { resumeFlagsFor, sessionOptionsFromFlags, type CommonFlagValues } from '../src/index'

const baseFlags: CommonFlagValues = {
	prompt: Option.none(),
	resume: Option.none(),
	provider: Option.none(),
	model: Option.none(),
	role: Option.none(),
	profile: Option.none(),
	mode: Option.none(),
	rpi: false,
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

it.effect('lowers --rpi into the session options, composable with --mode', () =>
	Effect.gen(function* () {
		const options = yield* sessionOptionsFromFlags({ ...baseFlags, mode: Option.some('rlm'), rpi: true })

		expect(options.rpi).toBe(true)
		expect(options.mode).toBe('rlm')
	}),
)

it.effect('omits rpi when the flag is absent', () =>
	Effect.gen(function* () {
		const options = yield* sessionOptionsFromFlags(baseFlags)

		expect('rpi' in options).toBe(false)
	}),
)

it.effect('lowers --profile into the session options and omits it when absent', () =>
	Effect.gen(function* () {
		const withProfile = yield* sessionOptionsFromFlags({ ...baseFlags, profile: Option.some('ultraclaude') })
		const without = yield* sessionOptionsFromFlags(baseFlags)

		expect(withProfile.profile).toBe('ultraclaude')
		expect('profile' in without).toBe(false)
	}),
)

it.effect('builds resume suggestions from the current run flags', () =>
	Effect.gen(function* () {
		const options = yield* sessionOptionsFromFlags({
			...baseFlags,
			profile: Option.some('ultracodex'),
			mode: Option.some('rlm'),
			rpi: true,
			reasoning: Option.some('high'),
			tartHome: Option.some('/tmp/tart home'),
			autoCompact: true,
			compactionReserveTokens: Option.some(12_000),
		})

		expect(resumeFlagsFor(options)).toEqual([
			{ name: 'cwd', value: '/tmp/project' },
			{ name: 'tart-home', value: '/tmp/tart home' },
			{ name: 'mode', value: 'rlm' },
			{ name: 'rpi' },
			{ name: 'profile', value: 'ultracodex' },
			{ name: 'reasoning', value: 'high' },
			{ name: 'auto-compact' },
			{ name: 'compaction-reserve-tokens', value: '12000' },
		])
	}),
)
