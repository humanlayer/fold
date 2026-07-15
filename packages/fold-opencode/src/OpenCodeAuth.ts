/**
 * OpenCode Console OAuth client. Device endpoints and polling semantics are adapted from OpenCode's
 * MIT-licensed client implementation; see ../NOTICE and ../LICENSE.opencode.
 */
import { Clock, Context, Duration, Effect, Option, Schema, Semaphore } from 'effect'
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

import type { OpenCodeAuthStore } from './AuthStore'
import { makeOpenCodeAuthStore, OpenCodeTokenData } from './AuthStore'

export const OPENCODE_CONSOLE_URL = 'https://console.opencode.ai'
export const OPENCODE_CLIENT_ID = 'opencode-cli'

const Device = Schema.Struct({
	device_code: Schema.String,
	user_code: Schema.String,
	verification_uri_complete: Schema.String,
	expires_in: Schema.Number,
	interval: Schema.Number,
})
const Token = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String, expires_in: Schema.Number })
const Pending = Schema.Struct({ error: Schema.String })
const DeviceToken = Schema.Union([Token, Pending])
const User = Schema.Struct({ id: Schema.String, email: Schema.String })
const Org = Schema.Struct({ id: Schema.String, name: Schema.String })

export class OpenCodeAuthError extends Schema.TaggedErrorClass<OpenCodeAuthError>()('OpenCodeAuthError', {
	reason: Schema.Literals(['NotAuthenticated', 'AuthorizationFailed', 'RefreshFailed', 'StoreFailed']),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}
export type OpenCodeDevicePrompt = { readonly url: string; readonly userCode: string }
export type OpenCodeAuthService = {
	readonly get: Effect.Effect<OpenCodeTokenData, OpenCodeAuthError>
	readonly authenticateDevice: Effect.Effect<OpenCodeTokenData, OpenCodeAuthError>
	readonly logout: Effect.Effect<void, OpenCodeAuthError>
}
export class OpenCodeAuth extends Context.Service<OpenCodeAuth, OpenCodeAuthService>()('fold/OpenCodeAuth') {}
export type MakeOpenCodeAuthOptions = {
	readonly store?: OpenCodeAuthStore
	readonly server?: string
	readonly onDeviceCode?: (prompt: OpenCodeDevicePrompt) => Effect.Effect<void>
}

const post = <S extends Schema.Top>(
	client: HttpClient.HttpClient,
	url: string,
	body: Record<string, string>,
	schema: S,
	statusOk = true,
) =>
	HttpClientRequest.post(url).pipe(
		HttpClientRequest.acceptJson,
		HttpClientRequest.schemaBodyJson(Schema.Record(Schema.String, Schema.String))(body),
		Effect.flatMap(client.execute),
		Effect.flatMap((r) => (statusOk ? HttpClientResponse.filterStatusOk(r) : Effect.succeed(r))),
		Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
	)
const get = <S extends Schema.Top>(client: HttpClient.HttpClient, url: string, access: string, schema: S) =>
	client
		.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(access)))
		.pipe(
			Effect.flatMap(HttpClientResponse.filterStatusOk),
			Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
		)

const credential = (client: HttpClient.HttpClient, server: string, token: typeof Token.Type) =>
	Effect.gen(function* () {
		const [user, orgs] = yield* Effect.all(
			[
				get(client, `${server}/api/user`, token.access_token, User),
				get(client, `${server}/api/orgs`, token.access_token, Schema.Array(Org)),
			],
			{ concurrency: 2 },
		)
		const org = orgs.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]
		const now = yield* Clock.currentTimeMillis
		return new OpenCodeTokenData({
			type: 'oauth',
			access: token.access_token,
			refresh: token.refresh_token,
			expires: now + token.expires_in * 1000,
			metadata: {
				server,
				accountID: user.id,
				email: user.email,
				...(org === undefined ? {} : { orgID: org.id, orgName: org.name }),
			},
		})
	})

const poll = (
	client: HttpClient.HttpClient,
	server: string,
	code: string,
	interval: Duration.Duration,
): Effect.Effect<OpenCodeTokenData, OpenCodeAuthError> =>
	Effect.sleep(interval).pipe(
		Effect.andThen(
			post(
				client,
				`${server}/auth/device/token`,
				{
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
					device_code: code,
					client_id: OPENCODE_CLIENT_ID,
				},
				DeviceToken,
				false,
			),
		),
		Effect.flatMap((result) => {
			if ('access_token' in result)
				return credential(client, server, result).pipe(
					Effect.mapError(
						(cause) =>
							new OpenCodeAuthError({
								reason: 'AuthorizationFailed',
								message: 'Failed to load OpenCode account metadata',
								cause,
							}),
					),
				)
			if (result.error === 'authorization_pending') return poll(client, server, code, interval)
			if (result.error === 'slow_down')
				return poll(client, server, code, Duration.sum(interval, Duration.seconds(5)))
			return Effect.fail(
				new OpenCodeAuthError({
					reason: 'AuthorizationFailed',
					message: `Device authorization failed: ${result.error}`,
				}),
			)
		}),
		Effect.mapError((cause) =>
			Schema.is(OpenCodeAuthError)(cause)
				? cause
				: new OpenCodeAuthError({
						reason: 'AuthorizationFailed',
						message: 'OpenCode device authorization failed',
						cause,
					}),
		),
	)

/** Build an auth service over the ambient HttpClient. */
export const makeOpenCodeAuth = Effect.fnUntraced(function* (options?: MakeOpenCodeAuthOptions) {
	const client = yield* HttpClient.HttpClient
	const store = options?.store ?? makeOpenCodeAuthStore()
	const server = options?.server ?? OPENCODE_CONSOLE_URL
	const lock = Semaphore.makeUnsafe(1)
	let current = yield* store.load
	const save = (token: OpenCodeTokenData) =>
		store.save(token).pipe(
			Effect.mapError((cause) => new OpenCodeAuthError({ reason: 'StoreFailed', message: cause.message, cause })),
			Effect.tap((saved) =>
				Effect.sync(() => {
					current = Option.some(saved)
				}),
			),
		)
	const refresh = (token: OpenCodeTokenData) =>
		post(
			client,
			`${token.metadata?.server ?? server}/auth/device/token`,
			{ grant_type: 'refresh_token', refresh_token: token.refresh, client_id: OPENCODE_CLIENT_ID },
			Token,
		).pipe(
			Effect.flatMap((next) => credential(client, token.metadata?.server ?? server, next)),
			Effect.mapError(
				(cause) =>
					new OpenCodeAuthError({
						reason: 'RefreshFailed',
						message: 'Failed to refresh OpenCode credentials',
						cause,
					}),
			),
			Effect.flatMap(save),
		)
	const getToken = Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		if (Option.isNone(current))
			return yield* new OpenCodeAuthError({
				reason: 'NotAuthenticated',
				message: `No OpenCode credentials found in ${store.path}; run the device login first.`,
			})
		return current.value.isExpired(now) ? yield* refresh(current.value) : current.value
	})
	return {
		get: lock.withPermit(getToken).pipe(Effect.withSpan('fold.opencode_auth.get')),
		authenticateDevice: lock
			.withPermit(
				Effect.gen(function* () {
					const device = yield* post(
						client,
						`${server}/auth/device/code`,
						{ client_id: OPENCODE_CLIENT_ID },
						Device,
					)
					yield* (options?.onDeviceCode ?? ((p) => Effect.log(`Open ${p.url} and enter code ${p.userCode}`)))(
						{ url: `${server}${device.verification_uri_complete}`, userCode: device.user_code },
					)
					return yield* poll(client, server, device.device_code, Duration.seconds(device.interval)).pipe(
						Effect.flatMap(save),
					)
				}).pipe(
					Effect.mapError((cause) =>
						Schema.is(OpenCodeAuthError)(cause)
							? cause
							: new OpenCodeAuthError({
									reason: 'AuthorizationFailed',
									message: 'Unable to start OpenCode device authorization',
									cause,
								}),
					),
				),
			)
			.pipe(Effect.withSpan('fold.opencode_auth.authenticate_device')),
		logout: lock
			.withPermit(
				store.clear.pipe(
					Effect.mapError(
						(cause) => new OpenCodeAuthError({ reason: 'StoreFailed', message: cause.message, cause }),
					),
					Effect.tap(() =>
						Effect.sync(() => {
							current = Option.none()
						}),
					),
				),
			)
			.pipe(Effect.withSpan('fold.opencode_auth.logout')),
	} satisfies OpenCodeAuthService
})

/** Authenticate inference requests with the current user token and organization. */
export const withOpenCodeAuth = (client: HttpClient.HttpClient, auth: OpenCodeAuthService): HttpClient.HttpClient =>
	client.pipe(
		HttpClient.mapRequestEffect((request) =>
			auth.get.pipe(
				Effect.map((token) =>
					request.pipe(
						HttpClientRequest.bearerToken(token.access),
						HttpClientRequest.setHeaders(
							token.metadata?.orgID === undefined ? {} : { 'x-org-id': token.metadata.orgID },
						),
					),
				),
				Effect.mapError(
					(cause) =>
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({ request, cause, description: cause.message }),
						}),
				),
			),
		),
	)
