import { Clock, Effect, Layer } from 'effect'

export type DeterministicClockOptions = {
	readonly startMillis?: number
	readonly stepMillis?: number
}

export const layerDeterministicClock = (options: DeterministicClockOptions = {}): Layer.Layer<never> =>
	Layer.sync(Clock.Clock, () => {
		let currentMillis = options.startMillis ?? 0
		const stepMillis = options.stepMillis ?? 1
		const nextMillis = () => {
			const value = currentMillis
			currentMillis += stepMillis
			return value
		}

		return {
			currentTimeMillis: Effect.sync(nextMillis),
			currentTimeMillisUnsafe: nextMillis,
			currentTimeNanos: Effect.sync(() => BigInt(nextMillis()) * 1_000_000n),
			currentTimeNanosUnsafe: () => BigInt(nextMillis()) * 1_000_000n,
			sleep: () => Effect.void,
		}
	})
