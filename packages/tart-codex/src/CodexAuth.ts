/**
 * Codex OAuth credential service: clanka's CodexAuth ported onto tart's file-backed auth store (D23).
 * `get` returns a valid access token - refreshing through a semaphore-guarded single flight under
 * `uninterruptibleMask` when expired - and fails with `NotAuthenticated` rather than launching an
 * interactive flow (tart-codex is an SDK; the device/browser flows are the explicit `authenticate*`
 * calls a CLI wires up). Unlike clanka, a failed refresh keeps the stored credential: refresh failures
 * are often transient, and silently discarding a refresh token would force a re-login. The exported
 * {@link withCodexAuth} wraps an HttpClient so every model request carries `Authorization` and
 * `ChatGPT-Account-Id` plus the agentlayer-mined `originator`/`User-Agent`/`session_id` identity
 * headers; auth failures surface as transport errors on the client's normal error channel.
 */
import { arch, platform, release } from 'node:os'

import { Clock, Context, Effect, Option, Semaphore } from 'effect'
import { HttpClient, HttpClientError, HttpClientRequest } from 'effect/unstable/http'

import type { CodexAuthStore } from './AuthStore'
import { CodexTokenData, makeCodexAuthStore } from './AuthStore'
import type { BrowserFlowOptions, DeviceCodePrompt } from './OAuthFlows'
import {
	CodexAuthError,
	makeIssuerHttpClient,
	preserveAccountId,
	refreshAccessToken,
	runBrowserFlow,
	runDeviceFlow,
} from './OAuthFlows'

/** Client version baked into the default User-Agent (agentlayer's Codex CLI parity value). */
export const CODEX_DEFAULT_CLIENT_VERSION = '1.15.7'

const ACCOUNT_ID_HEADER = 'ChatGPT-Account-Id'

/** The Codex-CLI-shaped User-Agent sent on model requests. */
export const buildCodexUserAgent = (version: string = CODEX_DEFAULT_CLIENT_VERSION): string =>
	`opencode/${version} (${platform()} ${release()}; ${arch()})`

/** The CodexAuth service surface. */
export type CodexAuthService = {
	/** A valid access token, transparently refreshed (single-flight) when expired. */
	readonly get: Effect.Effect<CodexTokenData, CodexAuthError>
	/** Run the headless device-code flow, persist and return the minted token. */
	readonly authenticateDevice: Effect.Effect<CodexTokenData, CodexAuthError>
	/** Run the browser PKCE loopback flow, persist and return the minted token. */
	readonly authenticateBrowser: Effect.Effect<CodexTokenData, CodexAuthError>
	/** Remove the stored credential. */
	readonly logout: Effect.Effect<void, CodexAuthError>
}

/** CodexAuth service tag. */
export class CodexAuth extends Context.Service<CodexAuth, CodexAuthService>()('tart/CodexAuth') {}

/** Options for {@link makeCodexAuth}. */
export type MakeCodexAuthOptions = {
	/** Credential store. Defaults to the `codex` entry of `~/.tart/auth.json`. */
	readonly store?: CodexAuthStore
	/** Presents the device-flow prompt. Defaults to logging the URL + code. */
	readonly onDeviceCode?: (prompt: DeviceCodePrompt) => Effect.Effect<void>
	/** Presents the browser-flow authorization URL. Defaults to logging it. */
	readonly onBrowserUrl?: (url: string) => Effect.Effect<void>
	/** Browser-flow loopback overrides (port defaults to 1455). */
	readonly browser?: Pick<BrowserFlowOptions, 'port' | 'hostname' | 'timeoutMs'>
}

const defaultOnDeviceCode = (prompt: DeviceCodePrompt): Effect.Effect<void> =>
	Effect.log(`To authenticate Codex, open ${prompt.verifyUrl} and enter the code: ${prompt.userCode}`)

const defaultOnBrowserUrl = (url: string): Effect.Effect<void> =>
	Effect.log(`To authenticate Codex, open this URL in your browser:\n${url}`)

/** Build a CodexAuth service over the ambient HttpClient. */
export const makeCodexAuth = Effect.fnUntraced(function* (options?: MakeCodexAuthOptions) {
	const store = options?.store ?? makeCodexAuthStore()
	const issuerClient = makeIssuerHttpClient(yield* HttpClient.HttpClient)
	const semaphore = Semaphore.makeUnsafe(1)

	let currentToken = yield* store.load

	const storeFailed = (cause: unknown) =>
		new CodexAuthError({
			reason: 'StoreFailed',
			message: `Failed to persist Codex credentials to ${store.path}`,
			cause,
		})

	const saveToken = (token: CodexTokenData): Effect.Effect<CodexTokenData, CodexAuthError> =>
		store.save(token).pipe(
			Effect.mapError(storeFailed),
			Effect.tap(() =>
				Effect.sync(() => {
					currentToken = Option.some(token)
				}),
			),
		)

	const clearToken = store.clear.pipe(
		Effect.mapError(storeFailed),
		Effect.tap(() =>
			Effect.sync(() => {
				currentToken = Option.none()
			}),
		),
	)

	const getNoLock = Effect.uninterruptibleMask(
		Effect.fnUntraced(function* (restore) {
			const now = yield* Clock.currentTimeMillis
			if (Option.isSome(currentToken) && !currentToken.value.isExpired(now)) {
				return currentToken.value
			}

			if (Option.isNone(currentToken)) {
				return yield* new CodexAuthError({
					reason: 'NotAuthenticated',
					message:
						`No Codex credentials found in ${store.path}. ` +
						'Authenticate with the device or browser flow, or copy an existing "codex" entry into the store.',
				})
			}

			const refreshed = yield* restore(refreshAccessToken(issuerClient, currentToken.value.refresh))
			return yield* saveToken(preserveAccountId(refreshed, currentToken.value.accountId))
		}),
	)

	const runFlow = (flow: Effect.Effect<CodexTokenData, CodexAuthError>) =>
		Effect.uninterruptibleMask((restore) => restore(flow).pipe(Effect.flatMap(saveToken)))

	const service: CodexAuthService = {
		get: semaphore.withPermit(getNoLock).pipe(Effect.withSpan('tart.codexAuth.get')),
		authenticateDevice: semaphore
			.withPermit(
				runFlow(runDeviceFlow({ client: issuerClient, onCode: options?.onDeviceCode ?? defaultOnDeviceCode })),
			)
			.pipe(Effect.withSpan('tart.codexAuth.authenticateDevice')),
		authenticateBrowser: semaphore
			.withPermit(
				runFlow(
					runBrowserFlow({
						client: issuerClient,
						onUrl: options?.onBrowserUrl ?? defaultOnBrowserUrl,
						...options?.browser,
					}),
				),
			)
			.pipe(Effect.withSpan('tart.codexAuth.authenticateBrowser')),
		logout: semaphore.withPermit(Effect.uninterruptible(clearToken)).pipe(Effect.withSpan('tart.codexAuth.logout')),
	}

	return service
})

/** Identity headers attached to every Codex model request. */
export type CodexIdentityOptions = {
	/** Overrides the default Codex-CLI-shaped User-Agent. */
	readonly userAgent?: string
	/** Client identity the backend gates on. Defaults to `opencode` (agentlayer parity). */
	readonly originator?: string
	/** Optional session id header, when the host tracks one. */
	readonly sessionId?: string
}

const applyTokenHeaders = (
	request: HttpClientRequest.HttpClientRequest,
	token: CodexTokenData,
	identity?: CodexIdentityOptions,
): HttpClientRequest.HttpClientRequest => {
	let authenticated = request.pipe(
		HttpClientRequest.bearerToken(token.access),
		HttpClientRequest.setHeader('originator', identity?.originator ?? 'opencode'),
		HttpClientRequest.setHeader('User-Agent', identity?.userAgent ?? buildCodexUserAgent()),
	)

	if (token.accountId !== undefined) {
		authenticated = authenticated.pipe(HttpClientRequest.setHeader(ACCOUNT_ID_HEADER, token.accountId))
	}
	if (identity?.sessionId !== undefined) {
		authenticated = authenticated.pipe(HttpClientRequest.setHeader('session_id', identity.sessionId))
	}

	return authenticated
}

/**
 * Wrap an HttpClient so every request authenticates as the stored Codex credential (refreshing when
 * needed) and carries the Codex identity headers. Auth failures surface as `TransportError`s on the
 * client's normal error channel, so downstream provider error mapping stays uniform.
 */
export const withCodexAuth = (
	client: HttpClient.HttpClient,
	auth: CodexAuthService,
	identity?: CodexIdentityOptions,
): HttpClient.HttpClient =>
	client.pipe(
		HttpClient.mapRequestEffect((request) =>
			auth.get.pipe(
				Effect.map((token) => applyTokenHeaders(request, token, identity)),
				Effect.mapError(
					(cause) =>
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({
								request,
								cause,
								description: `Codex authentication failed: ${cause.message}`,
							}),
						}),
				),
			),
		),
	)
