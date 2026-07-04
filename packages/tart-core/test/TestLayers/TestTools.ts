import { Effect, Ref, Schema } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'

import { defineToolState, ToolEvents, ToolState } from '../../src/index'

export const EchoState = defineToolState({
	namespace: 'echo',
	keys: {
		last: Schema.String,
	},
})

export const EchoTool = Tool.make('echo', {
	description: 'Echoes text back to the model.',
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.Struct({ echoed: Schema.String }),
	failure: Schema.Struct({ message: Schema.String }),
	failureMode: 'return',
	dependencies: [ToolState, ToolEvents],
})

export const TestToolkit = Toolkit.make(EchoTool)

export type EchoRecorder = {
	readonly calls: Ref.Ref<ReadonlyArray<string>>
}

export const makeEchoRecorder = (): Effect.Effect<EchoRecorder> =>
	Effect.gen(function* () {
		const calls = yield* Ref.make<ReadonlyArray<string>>([])
		return { calls }
	})

export const layerEchoTool = (recorder: EchoRecorder) =>
	TestToolkit.toLayer(
		TestToolkit.of({
			echo: ({ text }) =>
				Effect.gen(function* () {
					yield* Ref.update(recorder.calls, (calls) => [...calls, text])
					return { echoed: text }
				}),
		}),
	)

export const layerStatefulEchoTool = (recorder: EchoRecorder) =>
	TestToolkit.toLayer(
		TestToolkit.of({
			echo: ({ text }) =>
				Effect.gen(function* () {
					yield* EchoState.set('last', text)
					yield* Ref.update(recorder.calls, (calls) => [...calls, text])

					return { echoed: text }
				}),
		}),
	)

export const layerEventfulEchoTool = (recorder: EchoRecorder) =>
	TestToolkit.toLayer(
		TestToolkit.of({
			echo: ({ text }) =>
				Effect.gen(function* () {
					const events = yield* ToolEvents
					yield* events.emit({ progress: `working:${text}` })
					yield* Ref.update(recorder.calls, (calls) => [...calls, text])

					return { echoed: text }
				}),
		}),
	)
