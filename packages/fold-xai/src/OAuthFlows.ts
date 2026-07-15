/** xAI OAuth wire protocol, adapted from opencode's xAI plugin (MIT; see LICENSE-opencode). */
import { createServer } from 'node:http'
import type { Server } from 'node:http'

import { Clock, Deferred, Duration, Effect, Schedule, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

import { XaiTokenData } from './AuthStore'

export const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const XAI_ISSUER = 'https://auth.x.ai'
export const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
export const XAI_BROWSER_PORT = 56121
export const XAI_BROWSER_REDIRECT_URI = `http://127.0.0.1:${XAI_BROWSER_PORT}/callback`

const TOKEN_PATH = '/oauth2/token'
const DEVICE_PATH = '/oauth2/device/code'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const DEFAULT_EXPIRY_SECONDS = 3600
const DEFAULT_DEVICE_EXPIRY_SECONDS = 300
const DEFAULT_POLL_SECONDS = 5
const POLL_MARGIN_MS = 3000

export class XaiAuthError extends Schema.TaggedErrorClass<XaiAuthError>()('XaiAuthError', {
	reason: Schema.Literals([
		'NotAuthenticated',
		'RefreshFailed',
		'TokenExchangeFailed',
		'DeviceFlowFailed',
		'BrowserFlowFailed',
		'StoreFailed',
	]),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

const TokenResponse = Schema.Struct({
	access_token: Schema.String,
	refresh_token: Schema.optional(Schema.String),
	expires_in: Schema.optional(Schema.Number),
})

const DeviceResponse = Schema.Struct({
	device_code: Schema.String,
	user_code: Schema.String,
	verification_uri: Schema.String,
	verification_uri_complete: Schema.optional(Schema.String),
	expires_in: Schema.optional(Schema.Number),
	interval: Schema.optional(Schema.Number),
})

const DeviceError = Schema.Struct({
	error: Schema.optional(Schema.String),
	error_description: Schema.optional(Schema.String),
})

const failure = (reason: XaiAuthError['reason'], message: string, cause?: unknown) =>
	new XaiAuthError({ reason, message, ...(cause === undefined ? {} : { cause }) })

const tokenData = (payload: typeof TokenResponse.Type, fallbackRefresh?: string) =>
	Effect.map(
		Clock.currentTimeMillis,
		(now) =>
			new XaiTokenData({
				type: 'oauth',
				access: payload.access_token,
				refresh: payload.refresh_token ?? fallbackRefresh ?? '',
				expires: now + (payload.expires_in ?? DEFAULT_EXPIRY_SECONDS) * 1000,
			}),
	)

/** Scope and harden an HttpClient for xAI's OAuth issuer. */
export const makeXaiIssuerClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
	client.pipe(
		HttpClient.mapRequest(HttpClientRequest.prependUrl(XAI_ISSUER)),
		HttpClient.filterStatusOk,
		HttpClient.retryTransient({
			times: 5,
			schedule: Schedule.exponential(150).pipe(Schedule.either(Schedule.spaced(5000))),
		}),
	)

const decodeToken = (
	response: HttpClientResponse.HttpClientResponse,
	reason: XaiAuthError['reason'],
	message: string,
	fallback?: string,
) =>
	HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
		Effect.mapError((cause) => failure(reason, message, cause)),
		Effect.flatMap((payload) => tokenData(payload, fallback)),
	)

/** Refresh a stored xAI OAuth credential, preserving rotating or omitted refresh tokens. */
export const refreshXaiAccessToken = Effect.fn('fold.xaiAuth.refresh')(function* (
	client: HttpClient.HttpClient,
	refresh: string,
) {
	const response = yield* HttpClientRequest.post(TOKEN_PATH).pipe(
		HttpClientRequest.bodyUrlParams({
			grant_type: 'refresh_token',
			refresh_token: refresh,
			client_id: XAI_CLIENT_ID,
		}),
		client.execute,
		Effect.mapError((cause) => failure('RefreshFailed', 'Failed to refresh the xAI access token', cause)),
	)
	return yield* decodeToken(response, 'RefreshFailed', 'Failed to decode the xAI refresh response', refresh)
})

const exchangeCode = Effect.fn('fold.xaiAuth.exchange')(function* (
	client: HttpClient.HttpClient,
	code: string,
	verifier: string,
) {
	const response = yield* HttpClientRequest.post(TOKEN_PATH).pipe(
		HttpClientRequest.bodyUrlParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: XAI_BROWSER_REDIRECT_URI,
			client_id: XAI_CLIENT_ID,
			code_verifier: verifier,
		}),
		client.execute,
		Effect.mapError((cause) =>
			failure('TokenExchangeFailed', 'Failed to exchange the xAI authorization code', cause),
		),
	)
	return yield* decodeToken(response, 'TokenExchangeFailed', 'Failed to decode the xAI token response')
})

export type XaiDevicePrompt = {
	readonly verificationUri: string
	readonly userCode: string
	readonly browserUrl: string
}
export type XaiDeviceFlowOptions = {
	readonly client: HttpClient.HttpClient
	readonly onCode: (prompt: XaiDevicePrompt) => Effect.Effect<void>
}

/** Run RFC 8628 device authorization, including pending/slow_down backoff and expiry. */
export const runXaiDeviceFlow = Effect.fn('fold.xaiAuth.deviceFlow')(function* (options: XaiDeviceFlowOptions) {
	const response = yield* HttpClientRequest.post(DEVICE_PATH).pipe(
		HttpClientRequest.bodyUrlParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE }),
		options.client.execute,
		Effect.mapError((cause) => failure('DeviceFlowFailed', 'Failed to request an xAI device code', cause)),
	)
	const device = yield* HttpClientResponse.schemaBodyJson(DeviceResponse)(response).pipe(
		Effect.mapError((cause) => failure('DeviceFlowFailed', 'Failed to decode the xAI device response', cause)),
	)
	yield* options.onCode({
		verificationUri: device.verification_uri,
		userCode: device.user_code,
		browserUrl: device.verification_uri_complete ?? device.verification_uri,
	})

	const started = yield* Clock.currentTimeMillis
	const deadline = started + (device.expires_in ?? DEFAULT_DEVICE_EXPIRY_SECONDS) * 1000
	let delayMs = Math.max(device.interval ?? DEFAULT_POLL_SECONDS, 1) * 1000
	while ((yield* Clock.currentTimeMillis) < deadline) {
		const poll = HttpClientRequest.post(TOKEN_PATH).pipe(
			HttpClientRequest.bodyUrlParams({
				grant_type: DEVICE_GRANT,
				client_id: XAI_CLIENT_ID,
				device_code: device.device_code,
			}),
			options.client.execute,
			Effect.result,
		)
		const result = yield* poll
		if (result._tag === 'Success')
			return yield* decodeToken(result.success, 'DeviceFlowFailed', 'Failed to decode the xAI device token')
		const body: typeof DeviceError.Type =
			result.failure.response === undefined
				? {}
				: yield* HttpClientResponse.schemaBodyJson(DeviceError)(result.failure.response).pipe(
						Effect.orElseSucceed((): typeof DeviceError.Type => ({})),
					)
		if (body.error === 'access_denied' || body.error === 'authorization_denied')
			return yield* failure('DeviceFlowFailed', 'xAI device authorization was denied')
		if (body.error === 'expired_token') return yield* failure('DeviceFlowFailed', 'xAI device code expired')
		if (body.error !== 'authorization_pending' && body.error !== 'slow_down') {
			return yield* failure(
				'DeviceFlowFailed',
				body.error_description ?? body.error ?? 'xAI device token exchange failed',
			)
		}
		if (body.error === 'slow_down') delayMs += 5000
		yield* Effect.sleep(Duration.millis(delayMs + POLL_MARGIN_MS))
	}
	return yield* failure('DeviceFlowFailed', 'xAI device authorization timed out')
})

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
const random = (length: number): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(length)))
		.map((byte) => CHARS[byte % CHARS.length])
		.join('')
const base64Url = (buffer: ArrayBuffer): string => Buffer.from(buffer).toString('base64url')

export type XaiPkce = { readonly verifier: string; readonly challenge: string }
export const generateXaiPkce: Effect.Effect<XaiPkce> = Effect.promise(async () => {
	const verifier = random(64)
	return { verifier, challenge: base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))) }
})

/** Build xAI's registered Grok CLI authorization URL. */
export const buildXaiAuthorizeUrl = (pkce: XaiPkce, state: string, nonce: string): string => {
	const query = new URLSearchParams({
		response_type: 'code',
		client_id: XAI_CLIENT_ID,
		redirect_uri: XAI_BROWSER_REDIRECT_URI,
		scope: XAI_SCOPE,
		code_challenge: pkce.challenge,
		code_challenge_method: 'S256',
		state,
		nonce,
		plan: 'generic',
		referrer: 'fold',
	})
	return `${XAI_ISSUER}/oauth2/authorize?${query.toString()}`
}

export type XaiBrowserFlowOptions = {
	readonly client: HttpClient.HttpClient
	readonly onUrl: (url: string) => Effect.Effect<void>
	readonly timeoutMs?: number
}

/** Run browser PKCE on xAI's fixed registered 127.0.0.1:56121 callback. */
export const runXaiBrowserFlow = Effect.fn('fold.xaiAuth.browserFlow')(function* (options: XaiBrowserFlowOptions) {
	const pkce = yield* generateXaiPkce
	const state = base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer)
	const nonce = base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer)
	const code = yield* Effect.scoped(
		Effect.gen(function* () {
			const callback = yield* Deferred.make<string, XaiAuthError>()
			yield* Effect.acquireRelease(
				Effect.tryPromise({
					try: () =>
						new Promise<Server>((resolve, reject) => {
							const server = createServer((request, response) => {
								const url = new URL(request.url ?? '/', XAI_BROWSER_REDIRECT_URI)
								const fail = (message: string, status = 400) => {
									Effect.runSync(Deferred.fail(callback, failure('BrowserFlowFailed', message)))
									response.writeHead(status, { 'Content-Type': 'text/plain' })
									response.end(message)
								}
								if (url.pathname !== '/callback') return fail('Not found', 404)
								const oauthError = url.searchParams.get('error')
								if (oauthError !== null)
									return fail(url.searchParams.get('error_description') ?? oauthError, 200)
								if (url.searchParams.get('state') !== state)
									return fail('Invalid state - potential CSRF attack')
								const received = url.searchParams.get('code')
								if (received === null) return fail('Missing authorization code')
								Effect.runSync(Deferred.succeed(callback, received))
								response.writeHead(200, { 'Content-Type': 'text/plain' })
								response.end('xAI authorization successful. Return to fold.')
							})
							server.once('error', reject)
							server.listen(XAI_BROWSER_PORT, '127.0.0.1', () => resolve(server))
						}),
					catch: (cause) =>
						failure(
							'BrowserFlowFailed',
							`Failed to start callback server on port ${XAI_BROWSER_PORT}`,
							cause,
						),
				}),
				(server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
			)
			yield* options.onUrl(buildXaiAuthorizeUrl(pkce, state, nonce))
			return yield* Deferred.await(callback).pipe(
				Effect.timeoutOrElse({
					duration: Duration.millis(options.timeoutMs ?? 300_000),
					orElse: () => Effect.fail(failure('BrowserFlowFailed', 'OAuth callback timed out')),
				}),
			)
		}),
	)
	return yield* exchangeCode(options.client, code, pkce.verifier)
})
