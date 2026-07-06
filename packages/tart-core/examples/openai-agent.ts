import { OpenAiClient, OpenAiLanguageModel } from '@effect/ai-openai'
import { Console, Effect, Layer, Redacted, Schema, Stream } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'
import { FetchHttpClient } from 'effect/unstable/http'

import {
	AgentRuntime,
	EventLog,
	Ids,
	layerLiveIds,
	layerMemory,
	liveAgentRuntimeLayer,
	liveToolRuntimeLayer,
	makeHookRunner,
	noopToolEventSink,
	ToolEventSink,
	toolsetLayerFromToolkit,
	type ActiveModel,
} from '../src/index'

const modelId = process.env.OPENAI_MODEL ?? 'gpt-5.5'
const apiKey = Bun.env.OPENAI_API_KEY

const EchoTool = Tool.make('echo', {
	description: 'Echoes text back to the model.',
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.Struct({ echoed: Schema.String }),
	failure: Schema.Struct({ message: Schema.String }),
	failureMode: 'return',
})

const ExampleToolkit = Toolkit.make(EchoTool)

const layerEchoTool = ExampleToolkit.toLayer(
	ExampleToolkit.of({
		echo: ({ text }) => Effect.succeed({ echoed: text }),
	}),
)

const activeModel: ActiveModel = {
	providerId: 'openai',
	providerKind: 'openai-compatible',
	modelId,
	role: null,
	requestedReasoningLevel: 'medium',
	reasoning: { _tag: 'effort', effort: 'medium' },
}

const makeOpenAiLayer = (apiKey: string) => {
	const clientLayer = OpenAiClient.layer({ apiKey: Redacted.make(apiKey) }).pipe(Layer.provide(FetchHttpClient.layer))

	return OpenAiLanguageModel.layer({ model: modelId }).pipe(Layer.provide(clientLayer))
}

const makeRuntimeLayer = (apiKey: string) => {
	const baseLayer = Layer.mergeAll(
		layerMemory,
		layerLiveIds,
		toolsetLayerFromToolkit(ExampleToolkit).pipe(Layer.provide(layerEchoTool)),
		makeHookRunner({}).pipe(Layer.provide(Layer.mergeAll(layerMemory, layerLiveIds))),
		Layer.succeed(ToolEventSink, noopToolEventSink),
	)
	const toolRuntimeLayer = liveToolRuntimeLayer.pipe(Layer.provideMerge(baseLayer))

	return liveAgentRuntimeLayer.pipe(
		Layer.provideMerge(Layer.mergeAll(baseLayer, toolRuntimeLayer, makeOpenAiLayer(apiKey))),
	)
}

const program = Effect.gen(function* () {
	const runtime = yield* AgentRuntime
	const eventLog = yield* EventLog
	const ids = yield* Ids
	const agentId = yield* ids.makeAgentId

	yield* runtime.start({
		agentId,
		parentAgentId: null,
		toolCallId: null,
		model: activeModel,
		systemPrompt:
			'You are a tiny Tart demo agent. When the user asks you to echo text, call the echo tool, then answer briefly.',
	})

	const finished = yield* runtime.run({
		agentId,
		parentAgentId: null,
		toolCallId: null,
		text: 'Use the echo tool with the exact text "hello from tart", then tell me what it returned.',
	})
	const entries = yield* Stream.runCollect(eventLog.entries())

	yield* Console.log(`finished: ${finished.outcome}`)
	yield* Console.log(`result: ${finished.resultText ?? '(no text)'}`)
	yield* Console.log(`log: ${entries.map((entry) => entry._tag).join(' -> ')}`)
})

if (apiKey === undefined || apiKey === '') {
	console.error('Set OPENAI_API_KEY to run this example.')
	process.exitCode = 1
} else {
	Effect.runPromise(program.pipe(Effect.provide(makeRuntimeLayer(apiKey)))).catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
