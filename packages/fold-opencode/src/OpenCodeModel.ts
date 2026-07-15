/** Fold model factory for models exposed through OpenCode Console / Zen. */
import { OpenAiClient as ResponsesClient, OpenAiLanguageModel as ResponsesLanguageModel } from '@effect/ai-openai'
import { OpenAiClient as ChatClient, OpenAiLanguageModel as ChatLanguageModel } from '@effect/ai-openai-compat'
import { customModel, resolveOpenAiReasoning } from '@humanlayer/fold-core'
import type { FoldModel, ReasoningLevel } from '@humanlayer/fold-core'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import type { Scope } from 'effect'
import type { LanguageModel } from 'effect/unstable/ai'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

import type { OpenCodeAuthStore } from './AuthStore'
import { makeOpenCodeAuth, OPENCODE_CONSOLE_URL, withOpenCodeAuth } from './OpenCodeAuth'

/** Public OpenCode Zen gateway used when Console does not return an override. */
export const OPENCODE_ZEN_API_URL = 'https://opencode.ai/zen/v1'
/** @deprecated Use {@link OPENCODE_ZEN_API_URL}. */
export const OPENCODE_INFERENCE_API_URL = OPENCODE_ZEN_API_URL
export const DEFAULT_OPENCODE_MODEL_ID = 'gpt-5.6-sol'
export const GROK_BUILD_MODEL_ID = 'grok-build-0.1'

const ProviderApi = Schema.Struct({
	api: Schema.optional(Schema.String),
	npm: Schema.optional(Schema.String),
})
const RemoteModel = Schema.Struct({
	id: Schema.optional(Schema.String),
	provider: Schema.optional(ProviderApi),
})
const RemoteProvider = Schema.Struct({
	api: Schema.optional(Schema.String),
	npm: Schema.optional(Schema.String),
	models: Schema.optional(Schema.Record(Schema.String, RemoteModel)),
})
const RemoteConfig = Schema.Struct({
	config: Schema.Struct({ provider: Schema.Record(Schema.String, RemoteProvider) }),
})

export type OpenCodeProtocol = 'responses' | 'chat-completions'
export type OpenCodeResolvedModel = {
	readonly apiUrl: string
	readonly model: string
	readonly packageName: string | undefined
	readonly protocol: OpenCodeProtocol
}

const protocolForPackage = (packageName: string | undefined, model: string): OpenCodeProtocol =>
	packageName === '@ai-sdk/openai-compatible' || (packageName === undefined && model === GROK_BUILD_MODEL_ID)
		? 'chat-completions'
		: 'responses'

/** Resolve the model-level API override exactly as OpenCode overlays its remote provider catalog. */
export const resolveOpenCodeModelConfig = (
	providers: typeof RemoteConfig.Type.config.provider | undefined,
	model: string,
	apiUrlOverride?: string,
): OpenCodeResolvedModel => {
	for (const provider of Object.values(providers ?? {})) {
		const configured = provider.models?.[model]
		if (configured === undefined) continue
		const packageName = configured.provider?.npm ?? provider.npm
		return {
			apiUrl: apiUrlOverride ?? configured.provider?.api ?? provider.api ?? OPENCODE_ZEN_API_URL,
			model: configured.id ?? model,
			packageName,
			protocol: protocolForPackage(packageName, model),
		}
	}
	return {
		apiUrl: apiUrlOverride ?? OPENCODE_ZEN_API_URL,
		model,
		packageName: undefined,
		protocol: protocolForPackage(undefined, model),
	}
}

export type OpenCodeModelOptions = {
	readonly model?: string
	readonly reasoning?: ReasoningLevel
	readonly providerId?: string
	/** Explicit inference base URL. This takes precedence over Console's remote config. */
	readonly apiUrl?: string
	readonly consoleUrl?: string
	readonly store?: OpenCodeAuthStore
}

const fetchRemoteProviders = (authenticated: HttpClient.HttpClient, server: string) =>
	authenticated.execute(HttpClientRequest.get(`${server}/api/config`).pipe(HttpClientRequest.acceptJson)).pipe(
		Effect.flatMap((response) =>
			response.status === 404
				? Effect.as(Effect.void, undefined)
				: HttpClientResponse.filterStatusOk(response).pipe(
						Effect.flatMap(HttpClientResponse.schemaBodyJson(RemoteConfig)),
						Effect.map((remote) => remote.config.provider),
					),
		),
		Effect.catch((cause) =>
			Effect.logWarning('Failed to load OpenCode provider config; using Zen defaults', { cause }).pipe(
				Effect.as(undefined),
			),
		),
	)

/** Construct the Effect LanguageModel backed by stored OpenCode OAuth credentials. */
export const makeOpenCodeLanguageModel = (
	options: OpenCodeModelOptions = {},
): Effect.Effect<LanguageModel.Service, never, Scope.Scope> =>
	Effect.gen(function* () {
		const httpContext = yield* Layer.build(FetchHttpClient.layer)
		const http = Context.get(httpContext, HttpClient.HttpClient)
		const auth = yield* makeOpenCodeAuth({
			...(options.store === undefined ? {} : { store: options.store }),
			...(options.consoleUrl === undefined ? {} : { server: options.consoleUrl }),
		}).pipe(Effect.provideService(HttpClient.HttpClient, http))
		const authenticated = withOpenCodeAuth(http, auth)
		const requestedModel = options.model ?? DEFAULT_OPENCODE_MODEL_ID
		const credential = yield* Effect.option(auth.get)
		const credentialServer = Option.isSome(credential) ? credential.value.metadata?.server : undefined
		const providers = yield* fetchRemoteProviders(
			authenticated,
			options.consoleUrl ?? credentialServer ?? OPENCODE_CONSOLE_URL,
		)
		const resolved = resolveOpenCodeModelConfig(providers, requestedModel, options.apiUrl)
		const reasoning = resolveOpenAiReasoning(options.reasoning ?? 'off')

		if (resolved.protocol === 'chat-completions') {
			const clientContext = yield* Layer.build(ChatClient.layer({ apiUrl: resolved.apiUrl })).pipe(
				Effect.provideService(HttpClient.HttpClient, authenticated),
			)
			return yield* ChatLanguageModel.make({
				model: resolved.model,
				config: reasoning._tag === 'disabled' ? {} : { reasoning: { effort: reasoning.effort } },
			}).pipe(Effect.provideService(ChatClient.OpenAiClient, Context.get(clientContext, ChatClient.OpenAiClient)))
		}

		const clientContext = yield* Layer.build(ResponsesClient.layer({ apiUrl: resolved.apiUrl })).pipe(
			Effect.provideService(HttpClient.HttpClient, authenticated),
		)
		return yield* ResponsesLanguageModel.make({
			model: resolved.model,
			config: reasoning._tag === 'disabled' ? {} : { reasoning: { effort: reasoning.effort } },
		}).pipe(
			Effect.provideService(
				ResponsesClient.OpenAiClient,
				Context.get(clientContext, ResponsesClient.OpenAiClient),
			),
		)
	})

/** Create a Fold model descriptor directly usable by fold-agent's public session APIs. */
export const openCodeModel = (options: OpenCodeModelOptions = {}): FoldModel => {
	const reasoning = options.reasoning ?? 'off'
	return customModel({
		activeModel: {
			providerId: options.providerId ?? 'opencode',
			providerKind: 'openai-compatible',
			modelId: options.model ?? DEFAULT_OPENCODE_MODEL_ID,
			role: null,
			requestedReasoningLevel: reasoning,
			reasoning: resolveOpenAiReasoning(reasoning),
		},
		make: makeOpenCodeLanguageModel(options),
	})
}

/** Convenience descriptor for OpenCode Zen's OpenAI-compatible Grok Build model. */
export const grokBuildModel = (options: Omit<OpenCodeModelOptions, 'model'> = {}): FoldModel =>
	openCodeModel({ ...options, model: GROK_BUILD_MODEL_ID })
