/**
 * The fold-codex model descriptor: clanka's shape over the official `@effect/ai-openai` provider
 * pointed at the ChatGPT Codex backend (D23). The stock OpenAiLanguageModel runs unchanged; all Codex
 * behavior lives in a decorated OpenAiClient underneath it, where every signature is concrete:
 * (1) leading `system`/`developer` input items lift into the Responses `instructions` field (clanka's
 * systemPromptTransform, applied to the encoded payload - an explicit `instructions` from per-request
 * Config wins untouched); (2) streaming is hardened with first-event/idle stall timeouts and bounded
 * first-event retry; (3) non-streaming calls are served by streaming under the hood and taking the
 * terminal `response.completed`/`response.incomplete` event's response, because the backend rejects
 * `stream: false` outright. SSE is the transport: stateless full-input requests with no response-id
 * chaining, so every retry is a clean re-send; the WebSocket alternate is a config flag that lands
 * with the CLI (D23 amendment). Connection-level flakiness (connect errors, 408/429/5xx) retries at
 * the HttpClient seam via `retryTransient`, below the auth header injection so retries never re-enter
 * the auth path.
 */
import { OpenAiClient, OpenAiLanguageModel } from '@effect/ai-openai'
import * as OpenAiSchema from '@effect/ai-openai/OpenAiSchema'
import { customModel, resolveCodexReasoning } from '@humanlayer/fold-core'
import type { ReasoningLevel, FoldModel } from '@humanlayer/fold-core'
import { Context, Duration, Effect, Layer, Option, Schedule, Schema, Stream } from 'effect'
import type { Scope } from 'effect'
import { AiError } from 'effect/unstable/ai'
import type { LanguageModel } from 'effect/unstable/ai'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import type { HttpClientResponse } from 'effect/unstable/http'

import type { CodexAuthStore } from './AuthStore'
import type { CodexIdentityOptions } from './CodexAuth'
import { makeCodexAuth, withCodexAuth } from './CodexAuth'
import type { CodexHardeningOptions, CodexRetryOptions, StreamRetryInfo } from './Hardening'
import {
	CODEX_ERROR_MODULE,
	codexAcquisitionStallError,
	defaultCodexHardening,
	isCodexFirstEventStall,
	withFirstEventRetry,
	withStallTimeouts,
} from './Hardening'

/** The ChatGPT Codex backend the provider talks to (the client appends `/responses`). */
export const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex'

/** Default `retryTransient` attempts for connection-level failures on model requests. */
export const DEFAULT_REQUEST_RETRY_TIMES = 3

/** The codex model used when {@link CodexModelOptions.model} is omitted. */
export const DEFAULT_CODEX_MODEL_ID = 'gpt-5.6-sol'

type ResponsesPayload = Omit<typeof OpenAiSchema.CreateResponse.Encoded, 'stream'>
type ResponseBody = typeof OpenAiSchema.Response.Type
type ResponseEvent = typeof OpenAiSchema.ResponseStreamEvent.Type
type EventStream = Stream.Stream<ResponseEvent, AiError.AiError>

// The exact shape the provider emits for a prompt system message: a message item with plain string
// content. Anything else (array content, other roles, non-message items) ends the leading run.
const LeadingSystemItem = Schema.Struct({
	role: Schema.Literals(['system', 'developer']),
	content: Schema.String,
})

const decodeLeadingSystemItem = Schema.decodeUnknownOption(LeadingSystemItem)

/**
 * Lift the leading run of `system`/`developer` message items into the Responses `instructions` field.
 * The Codex backend takes operator guidance as top-level instructions; inline (non-leading) system
 * items stay in position per D3. A payload that already carries `instructions` (an explicit
 * per-request Config override) is returned untouched.
 */
export const liftLeadingSystemIntoInstructions = (payload: ResponsesPayload): ResponsesPayload => {
	if (payload.instructions !== undefined) return payload

	const input = payload.input
	if (!Array.isArray(input)) return payload

	const leading: Array<string> = []
	for (const item of input) {
		const decoded = decodeLeadingSystemItem(item)
		if (Option.isNone(decoded)) break
		leading.push(decoded.value.content)
	}
	if (leading.length === 0) return payload

	return { ...payload, instructions: leading.join('\n\n'), input: input.slice(leading.length) }
}

type OutputItemDoneEvent = Extract<ResponseEvent, { type: 'response.output_item.done' }>
type TerminalResponseEvent = Extract<
	ResponseEvent,
	{ type: 'response.completed' | 'response.incomplete' | 'response.failed' }
>

// The event union's unknown-event fallback is typed `{ type: string }`, which a literal comparison
// cannot discriminate away - but its schema predicate rejects every *known* event type at decode
// time, so a known literal proves the specific event. These guards encode that decode invariant.
const isOutputItemDone = (event: ResponseEvent): event is OutputItemDoneEvent =>
	event.type === 'response.output_item.done'

const isTerminalEvent = (event: ResponseEvent): event is TerminalResponseEvent =>
	event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed'

type ResponseFold = {
	readonly items: ReadonlyArray<OutputItemDoneEvent['item']>
	readonly terminal: Option.Option<ResponseBody>
}

/**
 * Wrap the stock OpenAI client with the Codex behaviors. `createResponseStream` transforms the
 * payload and hardens the event stream; `createResponse` streams under the hood (the backend rejects
 * non-streaming requests with "Stream must be set to true") and returns the terminal event's
 * response, which also carries `generateText`/`generateObject` on the stock provider for free.
 */
export const decorateCodexClient = (inner: OpenAiClient.Service, options: CodexRetryOptions): OpenAiClient.Service => {
	const retrySchedule = Schedule.exponential(Duration.millis(options.firstEventRetryBaseDelayMs)).pipe(
		Schedule.either(Schedule.spaced(Duration.millis(options.firstEventRetryMaxDelayMs))),
		Schedule.jittered,
		Schedule.take(options.firstEventTimeoutRetries),
	)

	// One request attempt, bounded by the first-event timeout: a request that gets no response at all
	// ("no headers") stalls exactly like one whose stream never produces an event. Suspended so every
	// retry re-invokes the client - a genuinely fresh request, never a re-run of a captured effect.
	const acquireOnce = (payload: ResponsesPayload) =>
		Effect.suspend(() => inner.createResponseStream(payload)).pipe(
			Effect.timeoutOrElse({
				duration: Duration.millis(options.firstEventTimeoutMs),
				orElse: () => Effect.fail(codexAcquisitionStallError(options.firstEventTimeoutMs)),
			}),
		)

	const createResponseStream = (
		payload: ResponsesPayload,
	): Effect.Effect<readonly [HttpClientResponse.HttpClientResponse, EventStream], AiError.AiError> => {
		const transformed = liftLeadingSystemIntoInstructions(payload)

		// Attempt 0 acquires eagerly (its HttpClientResponse is the tuple's response); acquisition
		// stalls retry in-effect - nothing has streamed yet, so a re-send cannot duplicate anything.
		return acquireOnce(transformed).pipe(
			Effect.retry({ while: isCodexFirstEventStall, schedule: retrySchedule }),
			Effect.map(([response, firstStream]) => {
				let pending: EventStream | null = firstStream

				const makeAttempt = (): EventStream => {
					if (pending !== null) {
						const stream = pending
						pending = null
						return stream
					}

					// Re-acquisition inside the stream: a fresh request whose acquisition stall
					// surfaces as a stream failure, so withFirstEventRetry's budget covers it too.
					return Stream.unwrap(Effect.map(acquireOnce(transformed), ([, stream]) => stream))
				}

				const hardened = withFirstEventRetry(() => makeAttempt().pipe(withStallTimeouts(options)), options)

				const result: readonly [HttpClientResponse.HttpClientResponse, EventStream] = [response, hardened]
				return result
			}),
		)
	}

	const createResponse = (
		payload: typeof OpenAiSchema.CreateResponse.Encoded,
	): Effect.Effect<readonly [ResponseBody, HttpClientResponse.HttpClientResponse], AiError.AiError> =>
		createResponseStream(payload).pipe(
			Effect.flatMap(([httpResponse, stream]) =>
				Stream.runFold(
					stream,
					(): ResponseFold => ({ items: [], terminal: Option.none() }),
					(state, event) => {
						if (isOutputItemDone(event))
							return { items: [...state.items, event.item], terminal: state.terminal }
						if (isTerminalEvent(event)) return { items: state.items, terminal: Option.some(event.response) }
						return state
					},
				).pipe(
					Effect.flatMap(({ items, terminal }) => {
						if (Option.isNone(terminal)) {
							return Effect.fail(
								AiError.make({
									module: CODEX_ERROR_MODULE,
									method: 'createResponse',
									reason: new AiError.InternalProviderError({
										description: 'Codex stream ended without a terminal response event',
									}),
								}),
							)
						}

						// The ChatGPT backend's terminal event carries `output: []` (no server-side
						// storage); the finished items arrive as `response.output_item.done` events, so
						// graft them in. A terminal response that does carry output (standard OpenAI
						// behavior) wins as-is.
						const body: ResponseBody =
							terminal.value.output.length > 0 ? terminal.value : { ...terminal.value, output: items }

						const result: readonly [ResponseBody, HttpClientResponse.HttpClientResponse] = [
							body,
							httpResponse,
						]
						return Effect.succeed(result)
					}),
				),
			),
		)

	return { ...inner, createResponse, createResponseStream }
}

/** Options for {@link codexModel}. */
export type CodexModelOptions = {
	/** Codex model id, for example `gpt-5.6-sol`. Defaults to {@link DEFAULT_CODEX_MODEL_ID}. */
	readonly model?: string
	/** Reasoning level for requests. Defaults to `off`, which leaves the backend default untouched. */
	readonly reasoning?: ReasoningLevel
	/** Configured provider profile name recorded in the log. Defaults to `codex`. */
	readonly providerId?: string
	/** Override the backend base URL (testing/proxies). Defaults to the ChatGPT Codex backend. */
	readonly apiUrl?: string
	/** Credential store override. Defaults to the `codex` entry of `~/.fold/auth.json`. */
	readonly store?: CodexAuthStore
	/** Identity headers (`originator`/`User-Agent`/`session_id`) sent on model requests. */
	readonly identity?: CodexIdentityOptions
	/** Connection-level `retryTransient` attempts. Defaults to {@link DEFAULT_REQUEST_RETRY_TIMES}. */
	readonly requestRetryTimes?: number
	/** Stall timeout / retry overrides. Defaults to {@link defaultCodexHardening}. */
	readonly hardening?: Partial<CodexHardeningOptions>
	/** Observes stream retries (the future AgentEvents `stream-retry` seam). */
	readonly onStreamRetry?: (info: StreamRetryInfo) => Effect.Effect<void>
}

/**
 * Build the hardened Codex LanguageModel service. Self-contained: constructs its own fetch-backed
 * HttpClient, CodexAuth over the credential store, and the decorated OpenAiClient against the Codex
 * backend; the LanguageModel on top is the stock OpenAI provider.
 */
export const makeCodexLanguageModel = (
	options: CodexModelOptions,
): Effect.Effect<LanguageModel.Service, never, Scope.Scope> =>
	Effect.gen(function* () {
		const httpContext = yield* Layer.build(FetchHttpClient.layer)
		const baseClient = Context.get(httpContext, HttpClient.HttpClient)

		const auth = yield* makeCodexAuth(options.store === undefined ? {} : { store: options.store }).pipe(
			Effect.provideService(HttpClient.HttpClient, baseClient),
		)

		// retryTransient sits below the auth wrapper: connection retries reuse the injected headers and
		// never re-enter (or retry) the auth path itself.
		const modelClient = withCodexAuth(
			baseClient.pipe(
				HttpClient.retryTransient({ times: options.requestRetryTimes ?? DEFAULT_REQUEST_RETRY_TIMES }),
			),
			auth,
			options.identity,
		)

		const clientContext = yield* Layer.build(OpenAiClient.layer({ apiUrl: options.apiUrl ?? CODEX_API_URL })).pipe(
			Effect.provideService(HttpClient.HttpClient, modelClient),
		)
		const stockClient = Context.get(clientContext, OpenAiClient.OpenAiClient)

		const codexClient = decorateCodexClient(stockClient, {
			...defaultCodexHardening,
			...options.hardening,
			...(options.onStreamRetry === undefined ? {} : { onStreamRetry: options.onStreamRetry }),
		})

		const reasoning = resolveCodexReasoning(options.reasoning ?? 'off')

		return yield* OpenAiLanguageModel.make({
			model: options.model ?? DEFAULT_CODEX_MODEL_ID,
			config: {
				// The ChatGPT backend does no server-side response storage (clanka parity).
				store: false,
				...(reasoning._tag === 'disabled'
					? {}
					: { reasoning: { effort: reasoning.effort, summary: reasoning.summary } }),
			},
		}).pipe(Effect.provideService(OpenAiClient.OpenAiClient, codexClient))
	})

/**
 * Describe a model served by the ChatGPT Codex backend using stored Codex OAuth credentials. Plugs
 * into `startSession`/`switchModel` like any other model descriptor; the loop's per-request reasoning
 * and model-id binding work unchanged because the provider on top is the stock OpenAI one.
 */
export const codexModel = (options: CodexModelOptions): FoldModel => {
	const level = options.reasoning ?? 'off'

	return customModel({
		activeModel: {
			providerId: options.providerId ?? 'codex',
			providerKind: 'codex',
			modelId: options.model ?? DEFAULT_CODEX_MODEL_ID,
			role: null,
			requestedReasoningLevel: level,
			reasoning: resolveCodexReasoning(level),
		},
		make: makeCodexLanguageModel(options),
	})
}
