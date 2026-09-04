/** Codex connection precedence and Bedrock endpoint/model resolution. */
import { NODE_REGION_CONFIG_FILE_OPTIONS, NODE_REGION_CONFIG_OPTIONS } from '@smithy/config-resolver'
import { loadConfig } from '@smithy/node-config-provider'
import { Effect, Option, Schema } from 'effect'
import type { FileSystem } from 'effect'

import { CodexBedrockAuthData, makeCodexBedrockAuthStore } from './BedrockAuthStore'
import type { CodexBedrockAuthStore } from './BedrockAuthStore'
import { readCodexAmazonBedrockConfig } from './CodexConfig'

/** A caller-selected Codex authentication mode. */
export type CodexConnection =
	| { readonly type: 'chatgpt' }
	| {
			readonly type: 'bedrock'
			readonly profile?: string
			readonly region?: string
			readonly model?: string
			readonly baseUrl?: string
	  }

export type ResolvedCodexConnection =
	| { readonly type: 'chatgpt' }
	| {
			readonly type: 'bedrock'
			readonly profile?: string
			readonly region: string
			readonly model: string
			readonly baseUrl: string
	  }

export class CodexConnectionError extends Schema.TaggedError<CodexConnectionError>()('CodexConnectionError', {
	reason: Schema.Literals(['InvalidConfiguration', 'UnsupportedProvider', 'RegionUnavailable']),
	message: Schema.String,
}) {}

export type ResolveCodexConnectionOptions = {
	readonly connection?: CodexConnection
	readonly logicalModel: string
	readonly codexHome?: string
	readonly bedrockStore?: CodexBedrockAuthStore
	/** Test/embedding seam for the AWS region chain. */
	readonly resolveRegion?: (profile?: string) => Effect.Effect<string, CodexConnectionError>
}

const bedrockWireModel = (model: string): string => (model.startsWith('openai.') ? model : `openai.${model}`)

const defaultResolveRegion = (profile?: string): Effect.Effect<string, CodexConnectionError> => {
	const provider = loadConfig(
		NODE_REGION_CONFIG_OPTIONS,
		profile === undefined ? NODE_REGION_CONFIG_FILE_OPTIONS : { ...NODE_REGION_CONFIG_FILE_OPTIONS, profile },
	)
	return Effect.tryPromise({
		try: () => provider(),
		catch: () =>
			new CodexConnectionError({
				reason: 'RegionUnavailable',
				message: 'AWS region is unavailable. Configure a region in HumanLayer, Codex, or your AWS profile.',
			}),
	})
}

const validateAndNormalizeBaseUrl = (value: string): Effect.Effect<string, CodexConnectionError> =>
	Effect.try({
		try: () => {
			const url = new URL(value)
			const hostname = url.hostname.toLowerCase()
			const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
			const loopback =
				hostname === 'localhost' ||
				hostname.endsWith('.localhost') ||
				hostname === '[::1]' ||
				(ipv4 !== null && Number(ipv4[1]) === 127 && ipv4.slice(1).every((part) => Number(part) <= 255))
			if (
				(url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
				url.username ||
				url.password
			) {
				throw new Error('unsafe URL')
			}
			if (url.search !== '' || url.hash !== '') throw new Error('query and fragment are unsupported')
			const normalizedPath = url.pathname.replace(/\/+$/, '')
			const basePath = normalizedPath.endsWith('/responses')
				? normalizedPath.slice(0, -'/responses'.length)
				: normalizedPath
			url.pathname = basePath || '/'
			return url.toString().replace(/\/$/, '')
		},
		catch: () =>
			new CodexConnectionError({
				reason: 'InvalidConfiguration',
				message:
					'The Amazon Bedrock base URL must be HTTPS without credentials, a query string, or a fragment.',
			}),
	})

const resolveBedrock = (
	connection: Exclude<CodexConnection, { readonly type: 'chatgpt' }>,
	logicalModel: string,
	resolveRegion: (profile?: string) => Effect.Effect<string, CodexConnectionError>,
): Effect.Effect<ResolvedCodexConnection, CodexConnectionError> =>
	Effect.gen(function* () {
		const region = connection.region ?? (yield* resolveRegion(connection.profile))
		if (region.trim() === '') {
			return yield* new CodexConnectionError({
				reason: 'RegionUnavailable',
				message: 'AWS region is unavailable. Configure a region in HumanLayer, Codex, or your AWS profile.',
			})
		}
		const defaultBaseUrl = `https://bedrock-mantle.${region}.api.aws/openai/v1`
		const baseUrl = yield* validateAndNormalizeBaseUrl(connection.baseUrl ?? defaultBaseUrl)
		const resolved: {
			type: 'bedrock'
			profile?: string
			region: string
			model: string
			baseUrl: string
		} = {
			type: 'bedrock',
			region,
			model: bedrockWireModel(connection.model ?? logicalModel),
			baseUrl,
		}
		if (connection.profile !== undefined) resolved.profile = connection.profile
		return resolved
	})

const toStoredConnection = (
	stored: CodexBedrockAuthData,
	fallback?: {
		readonly profile?: string
		readonly region?: string
		readonly model?: string
		readonly baseUrl?: string
	},
): Exclude<CodexConnection, { readonly type: 'chatgpt' }> => {
	const profile = stored.profile ?? fallback?.profile
	const region = stored.region ?? fallback?.region
	const model = stored.model ?? fallback?.model
	const baseUrl = stored.baseUrl ?? fallback?.baseUrl
	const connection: { type: 'bedrock'; profile?: string; region?: string; model?: string; baseUrl?: string } = {
		type: 'bedrock',
	}
	if (profile !== undefined) connection.profile = profile
	if (region !== undefined) connection.region = region
	if (model !== undefined) connection.model = model
	if (baseUrl !== undefined) connection.baseUrl = baseUrl
	return connection
}

/** Resolve explicit options, HumanLayer selection, then Codex CLI fallback, in that order. */
export const resolveCodexConnection = (
	options: ResolveCodexConnectionOptions,
): Effect.Effect<ResolvedCodexConnection, CodexConnectionError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const resolveRegion = options.resolveRegion ?? defaultResolveRegion
		if (options.connection?.type === 'chatgpt') return { type: 'chatgpt' } as const
		if (options.connection?.type === 'bedrock') {
			return yield* resolveBedrock(options.connection, options.logicalModel, resolveRegion)
		}

		const store = options.bedrockStore ?? (yield* makeCodexBedrockAuthStore())
		const stored = yield* store.load.pipe(
			Effect.mapError(
				(error) => new CodexConnectionError({ reason: 'InvalidConfiguration', message: error.message }),
			),
		)
		if (Option.isSome(stored) && stored.value.active === true) {
			return yield* resolveBedrock(toStoredConnection(stored.value), options.logicalModel, resolveRegion)
		}
		if (Option.isSome(stored) && stored.value.active === false) return { type: 'chatgpt' } as const

		const codexConfig = yield* readCodexAmazonBedrockConfig(
			options.codexHome === undefined ? {} : { codexHome: options.codexHome },
		).pipe(
			Effect.mapError(
				(error) => new CodexConnectionError({ reason: 'InvalidConfiguration', message: error.message }),
			),
		)
		if (Option.isNone(codexConfig)) return { type: 'chatgpt' } as const
		if (codexConfig.value.provider === 'amazon-bedrock-runtime') {
			return yield* new CodexConnectionError({
				reason: 'UnsupportedProvider',
				message: 'Codex provider "amazon-bedrock-runtime" is not supported; use "amazon-bedrock".',
			})
		}

		const fallback = codexConfig.value
		const connection = Option.isSome(stored)
			? toStoredConnection(stored.value, fallback)
			: toStoredConnection(new CodexBedrockAuthData({ type: 'aws-profile' }), fallback)
		return yield* resolveBedrock(connection, options.logicalModel, resolveRegion)
	}).pipe(Effect.withSpan('fold.codexConnection.resolve'))
