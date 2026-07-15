/** Persistent, single-flight xAI OAuth credential service and authenticated HTTP decorator. */
import { Clock, Context, Effect, Option, Semaphore } from 'effect'
import { HttpClient, HttpClientError, HttpClientRequest } from 'effect/unstable/http'

import type { XaiAuthStore } from './AuthStore'
import { makeXaiAuthStore, XaiTokenData } from './AuthStore'
import type { XaiBrowserFlowOptions, XaiDevicePrompt } from './OAuthFlows'
import {
	makeXaiIssuerClient,
	refreshXaiAccessToken,
	runXaiBrowserFlow,
	runXaiDeviceFlow,
	XaiAuthError,
} from './OAuthFlows'

export type XaiAuthService = {
	readonly get: Effect.Effect<XaiTokenData, XaiAuthError>
	readonly authenticateDevice: Effect.Effect<XaiTokenData, XaiAuthError>
	readonly authenticateBrowser: Effect.Effect<XaiTokenData, XaiAuthError>
	readonly logout: Effect.Effect<void, XaiAuthError>
}

export class XaiAuth extends Context.Service<XaiAuth, XaiAuthService>()('fold/XaiAuth') {}

export type MakeXaiAuthOptions = {
	readonly store?: XaiAuthStore
	readonly onDeviceCode?: (prompt: XaiDevicePrompt) => Effect.Effect<void>
	readonly onBrowserUrl?: (url: string) => Effect.Effect<void>
	readonly browser?: Pick<XaiBrowserFlowOptions, 'timeoutMs'>
}

const devicePrompt = (prompt: XaiDevicePrompt) =>
	Effect.log(`Open ${prompt.verificationUri} and enter code: ${prompt.userCode}`)
const browserPrompt = (url: string) => Effect.log(`Open this URL to authenticate xAI:\n${url}`)

/** Construct xAI auth over the ambient HttpClient. Interactive flows are explicit methods. */
export const makeXaiAuth = Effect.fnUntraced(function* (options?: MakeXaiAuthOptions) {
	const store = options?.store ?? makeXaiAuthStore()
	const client = makeXaiIssuerClient(yield* HttpClient.HttpClient)
	const semaphore = Semaphore.makeUnsafe(1)
	let current = yield* store.load
	const storeError = (cause: unknown) =>
		new XaiAuthError({
			reason: 'StoreFailed',
			message: `Failed to persist xAI credentials to ${store.path}`,
			cause,
		})
	const save = (token: XaiTokenData) =>
		store.save(token).pipe(
			Effect.mapError(storeError),
			Effect.tap(() =>
				Effect.sync(() => {
					current = Option.some(token)
				}),
			),
		)
	const get = Effect.uninterruptibleMask(
		Effect.fnUntraced(function* (restore) {
			const now = yield* Clock.currentTimeMillis
			if (Option.isSome(current) && !current.value.isExpired(now)) return current.value
			if (Option.isNone(current))
				return yield* new XaiAuthError({
					reason: 'NotAuthenticated',
					message: `No xAI OAuth credentials found in ${store.path}`,
				})
			return yield* restore(refreshXaiAccessToken(client, current.value.refresh)).pipe(Effect.flatMap(save))
		}),
	)
	const run = (flow: Effect.Effect<XaiTokenData, XaiAuthError>) =>
		Effect.uninterruptibleMask((restore) => restore(flow).pipe(Effect.flatMap(save)))
	return {
		get: semaphore.withPermit(get).pipe(Effect.withSpan('fold.xaiAuth.get')),
		authenticateDevice: semaphore
			.withPermit(run(runXaiDeviceFlow({ client, onCode: options?.onDeviceCode ?? devicePrompt })))
			.pipe(Effect.withSpan('fold.xaiAuth.authenticateDevice')),
		authenticateBrowser: semaphore
			.withPermit(
				run(runXaiBrowserFlow({ client, onUrl: options?.onBrowserUrl ?? browserPrompt, ...options?.browser })),
			)
			.pipe(Effect.withSpan('fold.xaiAuth.authenticateBrowser')),
		logout: semaphore
			.withPermit(
				store.clear.pipe(
					Effect.mapError(storeError),
					Effect.tap(() =>
						Effect.sync(() => {
							current = Option.none()
						}),
					),
				),
			)
			.pipe(Effect.withSpan('fold.xaiAuth.logout')),
	} satisfies XaiAuthService
})

/** Inject the current OAuth bearer token into every request without mutating caller headers. */
export const withXaiAuth = (client: HttpClient.HttpClient, auth: XaiAuthService): HttpClient.HttpClient =>
	client.pipe(
		HttpClient.mapRequestEffect((request) =>
			auth.get.pipe(
				Effect.map((token) =>
					request.pipe(
						HttpClientRequest.bearerToken(token.access),
						HttpClientRequest.setHeader('User-Agent', 'fold/xai-oauth'),
					),
				),
				Effect.mapError(
					(cause) =>
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({
								request,
								cause,
								description: `xAI authentication failed: ${cause.message}`,
							}),
						}),
				),
			),
		),
	)
