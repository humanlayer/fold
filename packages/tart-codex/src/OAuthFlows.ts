/**
 * Codex OAuth wire layer: token schemas, JWT account-id extraction, refresh/exchange requests, the
 * headless device-code flow (clanka port), and the browser PKCE loopback flow (agentlayer port -
 * localhost callback server, default port 1455). Endpoints, parameter names, and polling semantics are
 * kept verbatim from the two working implementations they were ported from (D23): both flows mint the
 * same {@link CodexTokenData} that CodexAuth persists to the auth store.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'

import { Clock, Deferred, Duration, Effect, Encoding, Option, Result, Schedule, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

import { CodexTokenData } from './AuthStore'

/** OAuth client id of the Codex CLI (both flows authenticate as it). */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** OpenAI auth issuer. */
export const CODEX_ISSUER = 'https://auth.openai.com'
/** URL a device-flow user visits to enter their code. */
export const CODEX_DEVICE_VERIFICATION_URL = `${CODEX_ISSUER}/codex/device`
/** Loopback port the browser PKCE flow listens on. */
export const DEFAULT_BROWSER_OAUTH_PORT = 1455

const DEVICE_CODE_URL = '/api/accounts/deviceauth/usercode'
const DEVICE_TOKEN_URL = '/api/accounts/deviceauth/token'
const TOKEN_URL = '/oauth/token'
const DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5
const POLLING_SAFETY_MARGIN_MS = 3000
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600
const BROWSER_FLOW_TIMEOUT_MS = 5 * 60 * 1000

/** OAuth flow failure. */
export class CodexAuthError extends Schema.TaggedErrorClass<CodexAuthError>()('CodexAuthError', {
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

const DeviceCodeResponse = Schema.Struct({
	device_auth_id: Schema.String,
	user_code: Schema.String,
	interval: Schema.String,
})

const AuthorizationCodeResponse = Schema.Struct({
	authorization_code: Schema.String,
	code_verifier: Schema.String,
})

const TokenResponse = Schema.Struct({
	id_token: Schema.optional(Schema.String),
	access_token: Schema.String,
	refresh_token: Schema.String,
	expires_in: Schema.optional(Schema.Number),
})

type TokenResponse = typeof TokenResponse.Type

// --- JWT account-id extraction (clanka port) --------------------------------------------------------

/** The id/access-token claims Codex account resolution reads. */
export type CodexJwtClaims = {
	readonly chatgpt_account_id?: string
	readonly 'https://api.openai.com/auth'?: { readonly chatgpt_account_id?: string }
	readonly organizations?: ReadonlyArray<{ readonly id: string }>
}

const decodeJwtJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const getString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const toJwtClaims = (value: unknown): Option.Option<CodexJwtClaims> => {
	if (!isRecord(value)) return Option.none()

	const accountId = getString(value['chatgpt_account_id'])
	const authValue = value['https://api.openai.com/auth']
	const nestedAccountId = isRecord(authValue) ? getString(authValue['chatgpt_account_id']) : undefined
	const organizationsValue = value['organizations']
	const organizationId =
		Array.isArray(organizationsValue) && organizationsValue[0] !== undefined && isRecord(organizationsValue[0])
			? getString(organizationsValue[0]['id'])
			: undefined

	return Option.some({
		...(accountId === undefined ? {} : { chatgpt_account_id: accountId }),
		...(nestedAccountId === undefined
			? {}
			: { 'https://api.openai.com/auth': { chatgpt_account_id: nestedAccountId } }),
		...(organizationId === undefined ? {} : { organizations: [{ id: organizationId }] }),
	})
}

const decodeJwtPayload = (token: string): Option.Option<string> => {
	const parts = token.split('.')
	if (parts.length !== 3) return Option.none()

	const payload = parts[1]
	if (payload === undefined) return Option.none()

	return Option.fromNullishOr(Result.getOrUndefined(Encoding.decodeBase64UrlString(payload)))
}

/** Best-effort JWT claim parse - malformed tokens are `none`, never failures. */
export const parseJwtClaims = (token: string): Option.Option<CodexJwtClaims> =>
	decodeJwtPayload(token).pipe(Option.flatMap(decodeJwtJson), Option.flatMap(toJwtClaims))

/** ChatGPT account id lookup order: direct claim, namespaced claim, first organization. */
export const extractAccountIdFromClaims = (claims: CodexJwtClaims): Option.Option<string> => {
	if (claims.chatgpt_account_id !== undefined && claims.chatgpt_account_id !== '') {
		return Option.some(claims.chatgpt_account_id)
	}

	const nestedAccountId = claims['https://api.openai.com/auth']?.chatgpt_account_id
	if (nestedAccountId !== undefined && nestedAccountId !== '') {
		return Option.some(nestedAccountId)
	}

	const organizationId = claims.organizations?.[0]?.id
	if (organizationId !== undefined && organizationId !== '') {
		return Option.some(organizationId)
	}

	return Option.none()
}

/** Extract the ChatGPT account id from one JWT, if present. */
export const extractAccountIdFromToken = (token: string): Option.Option<string> =>
	parseJwtClaims(token).pipe(Option.flatMap(extractAccountIdFromClaims))

const extractAccountId = (token: TokenResponse): string | undefined => {
	if (token.id_token !== undefined && token.id_token !== '') {
		const accountId = extractAccountIdFromToken(token.id_token)
		if (Option.isSome(accountId)) return accountId.value
	}

	return Option.getOrUndefined(extractAccountIdFromToken(token.access_token))
}

const toTokenData = (token: TokenResponse): Effect.Effect<CodexTokenData> =>
	Effect.map(Clock.currentTimeMillis, (now) => {
		const accountId = extractAccountId(token)

		return new CodexTokenData({
			type: 'oauth',
			access: token.access_token,
			refresh: token.refresh_token,
			expires: now + (token.expires_in ?? DEFAULT_TOKEN_EXPIRY_SECONDS) * 1000,
			...(accountId === undefined ? {} : { accountId }),
		})
	})

/** Carry an account id a token response omitted forward from the previous credential. */
export const preserveAccountId = (token: CodexTokenData, fallback: string | undefined): CodexTokenData =>
	token.accountId !== undefined || fallback === undefined
		? token
		: new CodexTokenData({
				type: token.type,
				access: token.access,
				refresh: token.refresh,
				expires: token.expires,
				accountId: fallback,
			})

// --- Issuer client + token requests -----------------------------------------------------------------

/**
 * The HttpClient every auth request goes through: issuer-relative URLs, non-2xx as errors, transient
 * failures retried (clanka's schedule - exponential from 150ms capped by a 5s spacing, 5 attempts).
 */
export const makeIssuerHttpClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
	client.pipe(
		HttpClient.mapRequest(HttpClientRequest.prependUrl(CODEX_ISSUER)),
		HttpClient.filterStatusOk,
		HttpClient.retryTransient({
			times: 5,
			schedule: Schedule.exponential(150).pipe(Schedule.either(Schedule.spaced(5000))),
		}),
	)

const refreshError = (message: string, cause?: unknown) =>
	new CodexAuthError({ reason: 'RefreshFailed', message, ...(cause === undefined ? {} : { cause }) })

const exchangeError = (message: string, cause?: unknown) =>
	new CodexAuthError({ reason: 'TokenExchangeFailed', message, ...(cause === undefined ? {} : { cause }) })

const deviceFlowError = (message: string, cause?: unknown) =>
	new CodexAuthError({ reason: 'DeviceFlowFailed', message, ...(cause === undefined ? {} : { cause }) })

const browserFlowError = (message: string, cause?: unknown) =>
	new CodexAuthError({ reason: 'BrowserFlowFailed', message, ...(cause === undefined ? {} : { cause }) })

/** Refresh an access token through the issuer. The client must come from {@link makeIssuerHttpClient}. */
export const refreshAccessToken = Effect.fn('tart.codexAuth.refreshAccessToken')(function* (
	client: HttpClient.HttpClient,
	refresh: string,
) {
	const response = yield* HttpClientRequest.post(TOKEN_URL).pipe(
		HttpClientRequest.bodyUrlParams({
			grant_type: 'refresh_token',
			refresh_token: refresh,
			client_id: CODEX_CLIENT_ID,
		}),
		client.execute,
		Effect.mapError((cause) => refreshError('Failed to refresh the Codex access token', cause)),
	)

	const payload = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
		Effect.mapError((cause) => refreshError('Failed to decode the Codex refresh token response', cause)),
	)

	return yield* toTokenData(payload)
})

const exchangeCode = Effect.fn('tart.codexAuth.exchangeCode')(function* (options: {
	readonly client: HttpClient.HttpClient
	readonly code: string
	readonly redirectUri: string
	readonly codeVerifier: string
}) {
	const response = yield* HttpClientRequest.post(TOKEN_URL).pipe(
		HttpClientRequest.bodyUrlParams({
			grant_type: 'authorization_code',
			code: options.code,
			redirect_uri: options.redirectUri,
			client_id: CODEX_CLIENT_ID,
			code_verifier: options.codeVerifier,
		}),
		options.client.execute,
		Effect.mapError((cause) => exchangeError('Failed to exchange the Codex authorization code', cause)),
	)

	const payload = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
		Effect.mapError((cause) => exchangeError('Failed to decode the Codex token exchange response', cause)),
	)

	return yield* toTokenData(payload)
})

// --- Device flow (clanka port) -----------------------------------------------------------------------

/** What a device-flow user must be shown to approve the login. */
export type DeviceCodePrompt = {
	readonly verifyUrl: string
	readonly userCode: string
}

/** Options for {@link runDeviceFlow}. */
export type DeviceFlowOptions = {
	/** Issuer-scoped client from {@link makeIssuerHttpClient}. */
	readonly client: HttpClient.HttpClient
	/** Presents the verification URL + user code (CLI prints it, a TUI renders it, ...). */
	readonly onCode: (prompt: DeviceCodePrompt) => Effect.Effect<void>
}

const normalizePollInterval = (interval: string): number =>
	Math.max(Number.parseInt(interval, 10) || DEFAULT_DEVICE_POLL_INTERVAL_SECONDS, 1) * 1000

/** Run the headless device-code flow to completion and return the minted token. */
export const runDeviceFlow = Effect.fn('tart.codexAuth.deviceFlow')(function* (options: DeviceFlowOptions) {
	const deviceResponse = yield* HttpClientRequest.post(DEVICE_CODE_URL).pipe(
		HttpClientRequest.bodyJsonUnsafe({ client_id: CODEX_CLIENT_ID }),
		options.client.execute,
		Effect.mapError((cause) => deviceFlowError('Failed to request a Codex device authorization code', cause)),
	)

	const deviceCode = yield* HttpClientResponse.schemaBodyJson(DeviceCodeResponse)(deviceResponse).pipe(
		Effect.mapError((cause) => deviceFlowError('Failed to decode the Codex device authorization response', cause)),
	)

	yield* options.onCode({ verifyUrl: CODEX_DEVICE_VERIFICATION_URL, userCode: deviceCode.user_code })

	const pollDelayMs = normalizePollInterval(deviceCode.interval) + POLLING_SAFETY_MARGIN_MS
	const pollRequest = HttpClientRequest.post(DEVICE_TOKEN_URL).pipe(
		HttpClientRequest.bodyJsonUnsafe({
			device_auth_id: deviceCode.device_auth_id,
			user_code: deviceCode.user_code,
		}),
	)

	// 403/404 mean "user has not approved yet" - ordinary polling control flow, not errors.
	const authorizationResponse = yield* options.client.execute(pollRequest).pipe(
		Effect.retry({
			while: (error) => error.response?.status === 403 || error.response?.status === 404,
			schedule: Schedule.spaced(pollDelayMs),
		}),
		Effect.mapError((cause) => deviceFlowError('Failed to poll Codex device authorization', cause)),
	)

	const authorization = yield* HttpClientResponse.schemaBodyJson(AuthorizationCodeResponse)(
		authorizationResponse,
	).pipe(Effect.mapError((cause) => deviceFlowError('Failed to decode the Codex authorization approval', cause)))

	return yield* exchangeCode({
		client: options.client,
		code: authorization.authorization_code,
		redirectUri: DEVICE_REDIRECT_URI,
		codeVerifier: authorization.code_verifier,
	})
})

// --- Browser PKCE flow (agentlayer port) -------------------------------------------------------------

const PKCE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

const generateRandomString = (length: number): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(length))
	return Array.from(bytes)
		.map((byte) => PKCE_CHARSET[byte % PKCE_CHARSET.length])
		.join('')
}

const base64UrlEncode = (buffer: ArrayBuffer): string => {
	const bytes = new Uint8Array(buffer)
	const binary = String.fromCharCode(...bytes)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** PKCE verifier + S256 challenge pair. */
export type PkceCodes = {
	readonly verifier: string
	readonly challenge: string
}

/** Generate a PKCE verifier (43 chars over the unreserved set) and its S256 challenge. */
export const generatePkce: Effect.Effect<PkceCodes> = Effect.promise(async () => {
	const verifier = generateRandomString(43)
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
	return { verifier, challenge: base64UrlEncode(hash) }
})

const generateState = (): string => base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)

/** The authorization URL a browser-flow user opens (agentlayer's exact parameter set). */
export const buildAuthorizeUrl = (redirectUri: string, pkce: PkceCodes, state: string): string => {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: CODEX_CLIENT_ID,
		redirect_uri: redirectUri,
		scope: 'openid profile email offline_access',
		code_challenge: pkce.challenge,
		code_challenge_method: 'S256',
		id_token_add_organizations: 'true',
		codex_cli_simplified_flow: 'true',
		state,
		originator: 'opencode',
	})

	return `${CODEX_ISSUER}/oauth/authorize?${params.toString()}`
}

const successHtml = `<!doctype html>
<html>
  <head><title>tart - Codex Authorization Successful</title></head>
  <body>
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to tart.</p>
    <script>setTimeout(() => window.close(), 2000)</script>
  </body>
</html>`

const errorHtml = (error: string): string => `<!doctype html>
<html>
  <head><title>tart - Codex Authorization Failed</title></head>
  <body>
    <h1>Authorization Failed</h1>
    <p>${error}</p>
  </body>
</html>`

/** Options for {@link runBrowserFlow}. */
export type BrowserFlowOptions = {
	/** Issuer-scoped client from {@link makeIssuerHttpClient}. */
	readonly client: HttpClient.HttpClient
	/** Given the authorization URL to present/open (tart never launches a browser itself). */
	readonly onUrl: (url: string) => Effect.Effect<void>
	/** Loopback port. Defaults to 1455 (the port registered for the Codex client id). */
	readonly port?: number
	readonly hostname?: string
	/** How long to wait for the callback. Defaults to 5 minutes. */
	readonly timeoutMs?: number
}

/**
 * Run the browser PKCE loopback flow: serve `/auth/callback` on localhost, hand the caller the
 * authorization URL, await the redirect, validate state, and exchange the code for tokens.
 */
export const runBrowserFlow = Effect.fn('tart.codexAuth.browserFlow')(function* (options: BrowserFlowOptions) {
	const port = options.port ?? DEFAULT_BROWSER_OAUTH_PORT
	const hostname = options.hostname ?? 'localhost'
	const timeoutMs = options.timeoutMs ?? BROWSER_FLOW_TIMEOUT_MS
	const redirectUri = `http://${hostname}:${port}/auth/callback`

	const pkce = yield* generatePkce
	const state = generateState()

	const code = yield* Effect.scoped(
		Effect.gen(function* () {
			const callback = yield* Deferred.make<string, CodexAuthError>()

			const handleRequest = (rawUrl: string): { status: number; contentType: string; body: string } => {
				const url = new URL(rawUrl, `http://${hostname}:${port}`)

				if (url.pathname === '/auth/callback') {
					const error = url.searchParams.get('error')
					if (error !== null) {
						const message = url.searchParams.get('error_description') ?? error
						Effect.runSync(Deferred.fail(callback, browserFlowError(message)))
						return { status: 200, contentType: 'text/html', body: errorHtml(message) }
					}

					const receivedCode = url.searchParams.get('code')
					if (receivedCode === null) {
						const message = 'Missing authorization code'
						Effect.runSync(Deferred.fail(callback, browserFlowError(message)))
						return { status: 400, contentType: 'text/html', body: errorHtml(message) }
					}

					if (url.searchParams.get('state') !== state) {
						const message = 'Invalid state - potential CSRF attack'
						Effect.runSync(Deferred.fail(callback, browserFlowError(message)))
						return { status: 400, contentType: 'text/html', body: errorHtml(message) }
					}

					Effect.runSync(Deferred.succeed(callback, receivedCode))
					return { status: 200, contentType: 'text/html', body: successHtml }
				}

				if (url.pathname === '/cancel') {
					Effect.runSync(Deferred.fail(callback, browserFlowError('Login cancelled')))
					return { status: 200, contentType: 'text/plain', body: 'Login cancelled' }
				}

				return { status: 404, contentType: 'text/plain', body: 'Not found' }
			}

			yield* Effect.acquireRelease(
				Effect.tryPromise({
					try: () =>
						new Promise<Server>((resolve, reject) => {
							const server = createServer((request, response) => {
								const result = handleRequest(request.url ?? '/')
								response.writeHead(result.status, { 'Content-Type': result.contentType })
								response.end(result.body)
							})
							server.once('error', reject)
							server.listen(port, hostname, () => resolve(server))
						}),
					catch: (cause) =>
						browserFlowError(`Failed to start the OAuth callback server on port ${port}`, cause),
				}),
				(server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
			)

			yield* options.onUrl(buildAuthorizeUrl(redirectUri, pkce, state))

			return yield* Deferred.await(callback).pipe(
				Effect.timeoutOrElse({
					duration: Duration.millis(timeoutMs),
					orElse: () => Effect.fail(browserFlowError('OAuth callback timeout - authorization took too long')),
				}),
			)
		}),
	)

	return yield* exchangeCode({ client: options.client, code, redirectUri, codeVerifier: pkce.verifier })
})
