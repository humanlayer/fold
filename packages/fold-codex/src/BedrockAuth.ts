import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
/** In-memory Bedrock bearer-token lifecycle and request authentication recovery. */
import { getToken as generateAwsBedrockToken } from '@aws/bedrock-token-generator'
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types'
import { Clock, Effect, Predicate, Schema, Semaphore } from 'effect'
import { HttpClient, HttpClientError, HttpClientRequest } from 'effect/unstable/http'
import type { HttpClientResponse } from 'effect/unstable/http'

export const BEDROCK_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60
export const BEDROCK_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

export class BedrockAuthError extends Schema.TaggedError<BedrockAuthError>()('BedrockAuthError', {
	reason: Schema.Literals(['CredentialsUnavailable', 'TokenGenerationFailed']),
	message: Schema.String,
}) {}

export type BedrockAuthService = {
	readonly getToken: Effect.Effect<string, BedrockAuthError>
	readonly invalidate: Effect.Effect<void>
}

export type MakeBedrockAuthOptions = {
	readonly profile?: string
	readonly region: string
	readonly credentialProviderFactory?: (profile?: string) => AwsCredentialIdentityProvider
	readonly generateToken?: (input: {
		readonly credentials: AwsCredentialIdentity
		readonly region: string
		readonly expiresInSeconds: number
	}) => Promise<string>
	readonly tokenLifetimeSeconds?: number
	readonly refreshBufferMs?: number
}

type BedrockAuthState = {
	generation: number
	credentialProvider: AwsCredentialIdentityProvider | undefined
	token: string | undefined
	refreshAt: number | undefined
}

const sanitizedAuthError = (reason: BedrockAuthError['reason']): BedrockAuthError =>
	new BedrockAuthError({
		reason,
		message:
			reason === 'CredentialsUnavailable'
				? 'AWS credentials are unavailable or expired. Refresh the AWS profile with your normal login command and retry.'
				: 'Amazon Bedrock authentication token generation failed. Refresh AWS credentials and retry.',
	})

/** Build one lazily refreshing auth instance for a model runtime. Generated keys are never persisted. */
export const makeBedrockAuth = (options: MakeBedrockAuthOptions): Effect.Effect<BedrockAuthService> => {
	const credentialProviderFactory =
		options.credentialProviderFactory ??
		((profile?: string) =>
			fromNodeProviderChain(profile === undefined ? { ignoreCache: true } : { profile, ignoreCache: true }))
	const generateToken = options.generateToken ?? generateAwsBedrockToken
	const tokenLifetimeSeconds = options.tokenLifetimeSeconds ?? BEDROCK_TOKEN_LIFETIME_SECONDS
	const refreshBufferMs = options.refreshBufferMs ?? BEDROCK_TOKEN_REFRESH_BUFFER_MS
	const semaphore = Semaphore.makeUnsafe(1)
	const state: BedrockAuthState = {
		generation: 0,
		credentialProvider: undefined,
		token: undefined,
		refreshAt: undefined,
	}

	const invalidate = Effect.sync(() => {
		state.generation += 1
		state.credentialProvider = undefined
		state.token = undefined
		state.refreshAt = undefined
	})

	const refreshToken: Effect.Effect<string, BedrockAuthError> = Effect.suspend(() =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			if (state.token !== undefined && state.refreshAt !== undefined && now < state.refreshAt) return state.token
			const refreshGeneration = state.generation

			const provider =
				state.credentialProvider ??
				(yield* Effect.try({
					try: () => credentialProviderFactory(options.profile),
					catch: () => sanitizedAuthError('CredentialsUnavailable'),
				}))
			state.credentialProvider = provider
			const credentials = yield* Effect.tryPromise({
				try: () => provider(),
				catch: () => sanitizedAuthError('CredentialsUnavailable'),
			})
			const token = yield* Effect.tryPromise({
				try: () =>
					generateToken({ credentials, region: options.region, expiresInSeconds: tokenLifetimeSeconds }),
				catch: () => sanitizedAuthError('TokenGenerationFailed'),
			})
			if (refreshGeneration !== state.generation) return yield* refreshToken

			const configuredExpiry = now + tokenLifetimeSeconds * 1000
			const credentialExpiry = credentials.expiration?.getTime()
			const effectiveExpiry =
				credentialExpiry === undefined ? configuredExpiry : Math.min(configuredExpiry, credentialExpiry)
			const remainingLifetime = Math.max(0, effectiveExpiry - now)
			state.token = token
			state.refreshAt =
				remainingLifetime <= refreshBufferMs
					? now + Math.floor(remainingLifetime / 2)
					: effectiveExpiry - refreshBufferMs
			return token
		}),
	)

	const getToken = Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		if (state.token !== undefined && state.refreshAt !== undefined && now < state.refreshAt) return state.token
		return yield* semaphore.withPermit(refreshToken)
	}).pipe(Effect.withSpan('fold.bedrockAuth.getToken'))

	return Effect.succeed({ getToken, invalidate: invalidate.pipe(Effect.withSpan('fold.bedrockAuth.invalidate')) })
}

const MAXIMUM_AUTH_ERROR_BODY_BYTES = 16_384

const webResponseSource = (response: unknown): Response | undefined => {
	if (Predicate.hasProperty(response, 'source') && response.source instanceof Response) return response.source
	return Predicate.hasProperty(response, 'original') ? webResponseSource(response.original) : undefined
}

const readResponsePrefix = async (response: Response, maximumBytes: number): Promise<string> => {
	const body = response.clone().body
	if (body === null) return ''
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let result = ''
	let bytesRead = 0
	try {
		while (bytesRead < maximumBytes) {
			const { done, value } = await reader.read()
			if (done) break
			const remaining = maximumBytes - bytesRead
			const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
			bytesRead += chunk.byteLength
			result += decoder.decode(chunk, { stream: bytesRead < maximumBytes })
		}
		result += decoder.decode()
		return result
	} finally {
		if (bytesRead >= maximumBytes) void reader.cancel().catch(() => undefined)
		reader.releaseLock()
	}
}

const isRecoverableAuthResponse = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<boolean, never> => {
	if (response.status === 401) return Effect.succeed(true)
	if (response.status !== 403) return Effect.succeed(false)
	const source = webResponseSource(response)
	if (source === undefined) return Effect.succeed(false)
	return Effect.tryPromise(() => readResponsePrefix(source, MAXIMUM_AUTH_ERROR_BODY_BYTES)).pipe(
		Effect.map(
			(body) =>
				body.includes('ExpiredToken') ||
				body.includes('UnrecognizedClientException') ||
				body.includes('InvalidClientTokenId'),
		),
		Effect.catch(() => Effect.succeed(false)),
	)
}

const toHttpAuthError = (
	request: HttpClientRequest.HttpClientRequest,
	cause: BedrockAuthError,
): HttpClientError.HttpClientError =>
	new HttpClientError.HttpClientError({
		reason: new HttpClientError.TransportError({
			request,
			cause,
			description: cause.message,
		}),
	})

/**
 * Authenticate each request with the current token. A qualifying auth response clears both token and
 * AWS provider state, then retries the original request exactly once with a rebuilt authorization header.
 */
export const withBedrockAuth = (client: HttpClient.HttpClient, auth: BedrockAuthService): HttpClient.HttpClient => {
	const executeAttempt = (
		request: HttpClientRequest.HttpClientRequest,
		allowAuthRecovery: boolean,
	): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
		auth.getToken.pipe(
			Effect.map((token) => request.pipe(HttpClientRequest.bearerToken(token))),
			Effect.mapError((cause) => toHttpAuthError(request, cause)),
			Effect.flatMap((authenticatedRequest) => client.execute(authenticatedRequest)),
			Effect.flatMap((response) => {
				if (!allowAuthRecovery) return Effect.succeed(response)
				return isRecoverableAuthResponse(response).pipe(
					Effect.flatMap((recoverable) =>
						recoverable
							? auth.invalidate.pipe(Effect.andThen(executeAttempt(request, false)))
							: Effect.succeed(response),
					),
				)
			}),
		)

	return HttpClient.makeWith<HttpClientError.HttpClientError, never, HttpClientError.HttpClientError, never>(
		Effect.flatMap((request: HttpClientRequest.HttpClientRequest) => executeAttempt(request, true)),
		(request) => Effect.succeed(request),
	)
}
