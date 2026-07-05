import { Effect, Layer } from 'effect'

import {
	HookRunner,
	layerMemory,
	makeHookRunner,
	StopController,
	type HookConfig,
	type StopControllerService,
} from '../../src/index'
import { layerDeterministicRuntime } from './DeterministicRuntime'
import { noopStopController } from './TestStopController'

/**
 * Run one scenario against a live HookRunner built from config, over a fresh memory EventLog and
 * deterministic ids/clock, with the given StopController (no-op unless the test asserts stopping).
 */
export const runWithHookRunner = <A, E>(
	config: HookConfig,
	effect: Effect.Effect<A, E, HookRunner | StopController>,
	stopController: StopControllerService = noopStopController,
): Effect.Effect<A, E> =>
	effect.pipe(
		Effect.provideService(StopController, stopController),
		Effect.provide(
			makeHookRunner(config).pipe(
				Layer.provide(
					Layer.mergeAll(layerMemory, layerDeterministicRuntime({ startMillis: 1_000, stepMillis: 0 })),
				),
			),
		),
	)
