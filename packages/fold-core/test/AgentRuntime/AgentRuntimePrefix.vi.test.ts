import { expect, it } from '@effect/vitest'
import { Array as Arr, Effect, Predicate, Schema } from 'effect'
import { Prompt } from 'effect/ai'

import { AgentRuntime } from '../../src/index'
import { makeScriptedLanguageModel, textTurn } from '../TestLayers/ScriptedLanguageModel'
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools'
import { agentRuntimeBaseLayer, runInput, startInput } from './AgentRuntimeTestHelpers'

/** Drop cache-control metadata and sort object keys so equal prompts encode to identical JSON. */
const withoutCacheControl = (value: Schema.Json): Schema.Json => {
	if (Arr.isArray<Schema.Json>(value)) return value.map(withoutCacheControl)
	if (typeof value !== 'object' || value === null) return value

	const out: Record<string, Schema.Json> = {}
	for (const [key, nested] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
		if (key === 'cacheControl') continue
		const normalized = withoutCacheControl(nested)
		if (key === 'anthropic' && Predicate.isObject(normalized) && Arr.isArrayEmpty(Object.keys(normalized))) continue
		out[key] = normalized
	}
	return out
}

const encodeMessages = Schema.encodeSync(Schema.Array(Prompt.Message))
const decodeJson = Schema.decodeUnknownSync(Schema.Json)
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const stablePromptJson = (messages: ReadonlyArray<Prompt.Message>): string =>
	encodeJsonString(withoutCacheControl(decodeJson(encodeMessages(messages))))

it.effect('keeps the second request prompt a byte-stable extension of the first', () =>
	Effect.gen(function* () {
		const recorder = yield* makeEchoRecorder
		const scripted = yield* makeScriptedLanguageModel([textTurn('One'), textTurn('Two')])
		const layer = agentRuntimeBaseLayer(scripted.layer, layerEchoTool(recorder))

		yield* Effect.gen(function* () {
			const runtime = yield* AgentRuntime

			yield* runtime.start(startInput())
			yield* runtime.run(runInput('first question'))
			yield* runtime.run(runInput('second question'))
		}).pipe(Effect.provide(layer))

		const prompts = yield* scripted.prompts
		expect(prompts).toHaveLength(2)

		const first = prompts[0]
		const second = prompts[1]
		if (first === undefined || second === undefined) throw new Error('expected two captured prompts')

		// The prompt-cache law: excluding request-local cache breakpoint metadata, the second request
		// begins with exactly the first request's messages.
		expect(second.content.length).toBeGreaterThan(first.content.length)
		expect(stablePromptJson(second.content.slice(0, first.content.length))).toBe(stablePromptJson(first.content))
	}),
)
