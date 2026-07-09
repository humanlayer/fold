import { OpenAiClient } from '@effect/ai-openai'
import * as OpenAiSchema from '@effect/ai-openai/OpenAiSchema'
import { describe, expect, it } from '@effect/vitest'
import { Context, Effect, Layer, Ref, Stream } from 'effect'
import { AiError } from 'effect/unstable/ai'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

import {
	codexModel,
	DEFAULT_CODEX_MODEL_ID,
	decorateCodexClient,
	defaultCodexHardening,
	liftLeadingSystemIntoInstructions,
} from '../src/index'
import type { CodexRetryOptions } from '../src/index'

type ResponsesPayload = Omit<typeof OpenAiSchema.CreateResponse.Encoded, 'stream'>
type ResponseEvent = typeof OpenAiSchema.ResponseStreamEvent.Type
type EventStream = Stream.Stream<ResponseEvent, AiError.AiError>

// The unknown-event fallback in the stream-event union makes plain tagged objects valid events.
const tick = (name: string): ResponseEvent => ({ type: `test.${name}` })

// The real ChatGPT backend's terminal event carries `output: []`; items arrive as
// `response.output_item.done` events, which createResponse grafts onto the terminal response.
const outputItemDoneEvent: ResponseEvent = {
	type: 'response.output_item.done',
	output_index: 0,
	sequence_number: 1,
	item: {
		id: 'msg_1',
		type: 'message',
		role: 'assistant',
		status: 'completed',
		content: [{ type: 'output_text', text: 'pong', annotations: [] }],
	},
}

const completedEvent: ResponseEvent = {
	type: 'response.completed',
	response: { id: 'resp_1', model: 'gpt-5.5', created_at: 1, output: [] },
	sequence_number: 2,
}

const payloadWithLeadingSystem: ResponsesPayload = {
	model: 'gpt-5.5',
	input: [
		{ role: 'developer', content: 'You are terse.' },
		{ role: 'system', content: 'Prefer bullet points.' },
		{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
	],
}

describe('liftLeadingSystemIntoInstructions', () => {
	it('lifts only the leading run of system/developer items', () => {
		const lifted = liftLeadingSystemIntoInstructions(payloadWithLeadingSystem)
		expect(lifted.instructions).toBe('You are terse.\n\nPrefer bullet points.')
		expect(lifted.input).toHaveLength(1)
	})

	it('leaves inline system items in position', () => {
		const lifted = liftLeadingSystemIntoInstructions({
			model: 'gpt-5.5',
			input: [
				{ role: 'developer', content: 'leading' },
				{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
				{ role: 'system', content: 'inline' },
			],
		})
		expect(lifted.instructions).toBe('leading')
		expect(lifted.input).toHaveLength(2)
	})

	it('an explicit instructions field wins untouched', () => {
		const lifted = liftLeadingSystemIntoInstructions({ ...payloadWithLeadingSystem, instructions: 'explicit' })
		expect(lifted.instructions).toBe('explicit')
		expect(lifted.input).toHaveLength(3)
	})

	it('passes payloads without leading system items through unchanged', () => {
		const payload: ResponsesPayload = {
			model: 'gpt-5.5',
			input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
		}
		expect(liftLeadingSystemIntoInstructions(payload)).toBe(payload)

		const stringInput: ResponsesPayload = { model: 'gpt-5.5', input: 'plain text' }
		expect(liftLeadingSystemIntoInstructions(stringInput)).toBe(stringInput)
	})
})

/** A scripted OpenAiClient whose stream attempts come from a factory, recording every payload. */
const makeScriptedClient = (makeStream: (attempt: number) => EventStream) =>
	Effect.gen(function* () {
		const payloads = yield* Ref.make<ReadonlyArray<ResponsesPayload>>([])
		const attempts = yield* Ref.make(0)
		const httpContext = yield* Layer.build(FetchHttpClient.layer)
		const httpClient = Context.get(httpContext, HttpClient.HttpClient)
		const httpResponse = HttpClientResponse.fromWeb(HttpClientRequest.get('http://scripted.test'), new Response(''))

		const service: OpenAiClient.Service = {
			client: httpClient,
			createResponse: () => Effect.die(new Error('unused - the decorator serves createResponse over the stream')),
			createResponseStream: (payload) =>
				Effect.gen(function* () {
					yield* Ref.update(payloads, (recorded) => [...recorded, payload])
					const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1)
					const result: readonly [typeof httpResponse, EventStream] = [httpResponse, makeStream(attempt)]
					return result
				}),
			createEmbedding: () => Effect.die(new Error('unused')),
		}

		return { service, payloads: Ref.get(payloads), attempts: Ref.get(attempts) }
	})

const fastOptions = (overrides?: Partial<CodexRetryOptions>): CodexRetryOptions => ({
	...defaultCodexHardening,
	firstEventTimeoutMs: 60,
	firstEventTimeoutRetries: 2,
	firstEventRetryBaseDelayMs: 1,
	firstEventRetryMaxDelayMs: 4,
	eventIdleTimeoutMs: 80,
	onStreamRetry: () => Effect.void,
	...overrides,
})

describe('decorateCodexClient', () => {
	it.effect('transforms the payload and passes stream events through', () =>
		Effect.gen(function* () {
			const scripted = yield* makeScriptedClient(() => Stream.make(tick('one'), tick('two')))
			const decorated = decorateCodexClient(scripted.service, fastOptions())

			const [, stream] = yield* decorated.createResponseStream(payloadWithLeadingSystem)
			const events = yield* Stream.runCollect(stream)

			expect(events.map((event) => event.type)).toEqual(['test.one', 'test.two'])

			const [payload] = yield* scripted.payloads
			expect(payload?.instructions).toBe('You are terse.\n\nPrefer bullet points.')
			expect(payload?.input).toHaveLength(1)
		}).pipe(Effect.scoped),
	)

	it.effect('createResponse streams under the hood and grafts finished items onto the terminal response', () =>
		Effect.gen(function* () {
			const scripted = yield* makeScriptedClient(() =>
				Stream.make(tick('one'), outputItemDoneEvent, completedEvent),
			)
			const decorated = decorateCodexClient(scripted.service, fastOptions())

			const [body] = yield* decorated.createResponse({ ...payloadWithLeadingSystem })
			expect(body.id).toBe('resp_1')
			expect(body.output).toHaveLength(1)
			expect(body.output[0]?.type).toBe('message')

			const [payload] = yield* scripted.payloads
			expect(payload?.instructions).toBe('You are terse.\n\nPrefer bullet points.')
		}).pipe(Effect.scoped),
	)

	it.effect('createResponse fails typed when the stream ends without a terminal event', () =>
		Effect.gen(function* () {
			const scripted = yield* makeScriptedClient(() => Stream.make(tick('one')))
			const decorated = decorateCodexClient(scripted.service, fastOptions())

			const error = yield* decorated.createResponse({ model: 'gpt-5.5', input: 'hi' }).pipe(Effect.flip)
			expect(error.module).toBe('tart-codex')
			expect(String(error)).toContain('without a terminal response event')
		}).pipe(Effect.scoped),
	)

	it.live('retries a first-event stall with a fresh request', () =>
		Effect.gen(function* () {
			const scripted = yield* makeScriptedClient((attempt) =>
				attempt === 1 ? Stream.fromEffect(Effect.never) : Stream.make(tick('one'), completedEvent),
			)
			const decorated = decorateCodexClient(scripted.service, fastOptions())

			const [, stream] = yield* decorated.createResponseStream({ model: 'gpt-5.5', input: 'hi' })
			const events = yield* Stream.runCollect(stream)

			expect(events).toHaveLength(2)
			expect(yield* scripted.attempts).toBe(2)
		}).pipe(Effect.scoped),
	)

	it.live('retries when the request itself gets no response (acquisition stall)', () =>
		Effect.gen(function* () {
			const attempts: Array<number> = []
			const httpContext = yield* Layer.build(FetchHttpClient.layer)
			const httpResponse = HttpClientResponse.fromWeb(
				HttpClientRequest.get('http://scripted.test'),
				new Response(''),
			)

			const service: OpenAiClient.Service = {
				client: Context.get(httpContext, HttpClient.HttpClient),
				createResponse: () => Effect.die(new Error('unused')),
				createResponseStream: () =>
					Effect.suspend(() => {
						attempts.push(attempts.length + 1)
						if (attempts.length === 1) return Effect.never
						const result: readonly [typeof httpResponse, EventStream] = [
							httpResponse,
							Stream.make(tick('one')),
						]
						return Effect.succeed(result)
					}),
				createEmbedding: () => Effect.die(new Error('unused')),
			}

			const decorated = decorateCodexClient(service, fastOptions({ firstEventTimeoutMs: 40 }))

			const [, stream] = yield* decorated.createResponseStream({ model: 'gpt-5.5', input: 'hi' })
			const events = yield* Stream.runCollect(stream)

			expect(events).toHaveLength(1)
			expect(attempts).toHaveLength(2)
		}).pipe(Effect.scoped),
	)
})

describe('codexModel defaults', () => {
	it('omitting the model binds the default codex model id', () => {
		const model = codexModel({})

		expect(DEFAULT_CODEX_MODEL_ID).toBe('gpt-5.6-sol')
		expect(model.activeModel.modelId).toBe(DEFAULT_CODEX_MODEL_ID)
		expect(model.activeModel.providerKind).toBe('codex')
	})

	it('an explicit model wins over the default', () => {
		expect(codexModel({ model: 'gpt-5.5' }).activeModel.modelId).toBe('gpt-5.5')
	})
})
