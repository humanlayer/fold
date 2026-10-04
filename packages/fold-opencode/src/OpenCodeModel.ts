/** Fold model factory for models exposed through OpenCode Console / Zen. */
import {
	OpenAiClient as ResponsesClient,
	OpenAiLanguageModel as ResponsesLanguageModel,
} from '@humanlayer/effect-ai-openai'
import {
	OpenAiClient as ChatClient,
	OpenAiLanguageModel as ChatLanguageModel,
} from '@humanlayer/effect-ai-openai-compat'
import { customModel, resolveOpenAiReasoning } from '@humanlayer/fold-core'
import type { FoldModel, ReasoningLevel } from '@humanlayer/fold-core'
import { Match, Context, Effect, Layer, Option, Schema } from 'effect'
import type { FileSystem, Scope } from 'effect'
import { LanguageModel } from 'effect/ai'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'

import { layerOpenCodeAuthStore, type OpenCodeAuthStoreOptions } from './AuthStore'
import { layerOpenCodeAuth, OPENCODE_CONSOLE_URL, OpenCodeAuth, openCodeAuthenticatedClient } from './OpenCodeAuth'

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
	// The public Zen URL is the fallback, not a routing override. Console's model catalog points
	// authenticated users at the correct inference gateway for their account.
	const override = apiUrlOverride === OPENCODE_ZEN_API_URL ? undefined : apiUrlOverride
	for (const provider of Object.values(providers ?? {})) {
		const configured = provider.models?.[model]
		if (configured === undefined) continue
		const packageName = configured.provider?.npm ?? provider.npm
		return {
			apiUrl: override ?? configured.provider?.api ?? provider.api ?? OPENCODE_ZEN_API_URL,
			model: configured.id ?? model,
			packageName,
			protocol: protocolForPackage(packageName, model),
		}
	}
	return {
		apiUrl: override ?? OPENCODE_ZEN_API_URL,
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
	/** The auth document holding this provider's credential, under the `providerId` entry. Defaults to `~/.fold/auth.json`. */
	readonly authStorePath?: string
}

/** The credential store for this model: its provider's entry in its auth document. */
const authStoreOptionsFor = (options: OpenCodeModelOptions): OpenCodeAuthStoreOptions =>
	options.authStorePath === undefined
		? { providerId: options.providerId ?? 'opencode' }
		: { providerId: options.providerId ?? 'opencode', path: options.authStorePath }

/** This model's OpenCodeAuth over its provider's credential store, on the host's HttpClient and FileSystem. */
const authLayerFor = (options: OpenCodeModelOptions) =>
	layerOpenCodeAuth(options.consoleUrl === undefined ? {} : { server: options.consoleUrl }).pipe(
		Layer.provide(layerOpenCodeAuthStore(authStoreOptionsFor(options))),
	)

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
): Effect.Effect<LanguageModel.LanguageModel, never, Scope.Scope | HttpClient.HttpClient | FileSystem.FileSystem> =>
	Layer.build(
		Layer.effect(
			LanguageModel.LanguageModel,
			Effect.gen(function* () {
				const auth = yield* OpenCodeAuth
				const authenticated = yield* openCodeAuthenticatedClient(yield* HttpClient.HttpClient)
				const requestedModel = options.model ?? DEFAULT_OPENCODE_MODEL_ID
				const credential = yield* Effect.option(auth.get)
				const credentialServer = Option.isSome(credential) ? credential.value.metadata?.server : undefined
				const providers = yield* fetchRemoteProviders(
					authenticated,
					options.consoleUrl ?? credentialServer ?? OPENCODE_CONSOLE_URL,
				)
				const resolved = resolveOpenCodeModelConfig(providers, requestedModel, options.apiUrl)
				const reasoning = resolveOpenAiReasoning(options.reasoning ?? 'off')
				const config = Match.valueTags(reasoning, {
					disabled: () => ({}),
					effort: ({ effort }) => ({ reasoning: { effort } }),
				})

				if (resolved.protocol === 'chat-completions') {
					const clientContext = yield* Layer.build(ChatClient.layer({ apiUrl: resolved.apiUrl })).pipe(
						Effect.provideService(HttpClient.HttpClient, authenticated),
					)
					return yield* ChatLanguageModel.make({
						model: resolved.model,
						config,
					}).pipe(
						Effect.provideService(
							ChatClient.OpenAiClient,
							Context.get(clientContext, ChatClient.OpenAiClient),
						),
					)
				}

				const clientContext = yield* Layer.build(ResponsesClient.layer({ apiUrl: resolved.apiUrl })).pipe(
					Effect.provideService(HttpClient.HttpClient, authenticated),
				)
				return yield* ResponsesLanguageModel.make({
					model: resolved.model,
					config,
				}).pipe(
					Effect.provideService(
						ResponsesClient.OpenAiClient,
						Context.get(clientContext, ResponsesClient.OpenAiClient),
					),
				)
			}),
		).pipe(Layer.provide(authLayerFor(options))),
	).pipe(Effect.map((context) => Context.get(context, LanguageModel.LanguageModel)))

/** Create a Fold model descriptor directly usable by fold-agent's public session APIs. */
export const openCodeModel = (
	options: OpenCodeModelOptions = {},
): FoldModel<HttpClient.HttpClient | FileSystem.FileSystem> => {
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
export const grokBuildModel = (
	options: Omit<OpenCodeModelOptions, 'model'> = {},
): FoldModel<HttpClient.HttpClient | FileSystem.FileSystem> => openCodeModel({ ...options, model: GROK_BUILD_MODEL_ID })
