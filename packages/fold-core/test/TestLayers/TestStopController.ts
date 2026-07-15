import { Effect, Layer, Ref } from 'effect'

import { StopController, type StopControllerService } from '../../src/index'

/** StopController that ignores stop requests, for tests that do not assert stopping. */
export const noopStopController: StopControllerService = {
	/** Ignore one stop request. */
	requestStop: () => Effect.void,
	/** Report that no stop has been requested. */
	isStopRequested: Effect.succeed(false),
}

/** Layer form of {@link noopStopController}. */
export const layerNoopStopController: Layer.Layer<StopController> = Layer.succeed(StopController, noopStopController)

/** Recording StopController plus the Ref its requests are collected into. */
export type RecordingStopController = {
	readonly service: StopControllerService
	readonly requests: Ref.Ref<ReadonlyArray<string>>
}

/** Build a StopController that records every requested stop reason for assertions. */
export const makeRecordingStopController: Effect.Effect<RecordingStopController> = Effect.gen(function* () {
	const requests = yield* Ref.make<ReadonlyArray<string>>([])

	return {
		requests,
		service: {
			/** Record one stop request reason. */
			requestStop: (reason) => Ref.update(requests, (reasons) => [...reasons, reason]),
			/** Report whether any stop request has been recorded. */
			isStopRequested: Ref.get(requests).pipe(Effect.map((reasons) => reasons.length > 0)),
		},
	}
})
