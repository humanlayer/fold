import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'

import {
	CodexTokenData,
	extractAccountIdFromToken,
	makeCodexAuth,
	makeCodexAuthStore,
	parseJwtClaims,
} from '../src/index'
import type { CodexAuthStore } from '../src/index'

const tempStorePath = (): string => join(mkdtempSync(join(tmpdir(), 'fold-codex-auth-')), 'auth.json')

const jwtWith = (claims: Record<string, unknown>): string =>
	`${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`

type RecordedRequest = { readonly url: string; readonly body: string }

/** A FetchHttpClient layer whose network is a scripted function, recording every request it serves. */
const scriptedFetchLayer = (
	respond: (request: RecordedRequest) => Response,
): { readonly layer: Layer.Layer<HttpClient.HttpClient>; readonly requests: Array<RecordedRequest> } => {
	const requests: Array<RecordedRequest> = []

	// Bun's `typeof fetch` carries a `preconnect` property; borrow the real one alongside the fake body.
	const fakeFetch: typeof fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const request = input instanceof Request ? input : new Request(String(input), init)
			const recorded = { url: request.url, body: await request.clone().text() }
			requests.push(recorded)
			return respond(recorded)
		},
		{ preconnect: fetch.preconnect },
	)

	const layer = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fakeFetch)))
	return { layer, requests }
}

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const storeWith = (token?: CodexTokenData): Effect.Effect<CodexAuthStore> =>
	Effect.gen(function* () {
		const store = makeCodexAuthStore({ path: tempStorePath() })
		if (token !== undefined) yield* Effect.orDie(store.save(token))
		return store
	})

describe('JWT account id extraction', () => {
	it('reads the direct claim first', () => {
		const token = jwtWith({ chatgpt_account_id: 'acct_direct' })
		expect(Option.getOrNull(extractAccountIdFromToken(token))).toBe('acct_direct')
	})

	it('falls back to the namespaced claim, then the first organization', () => {
		const namespaced = jwtWith({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_nested' } })
		expect(Option.getOrNull(extractAccountIdFromToken(namespaced))).toBe('acct_nested')

		const organization = jwtWith({ organizations: [{ id: 'org_1' }, { id: 'org_2' }] })
		expect(Option.getOrNull(extractAccountIdFromToken(organization))).toBe('org_1')
	})

	it('malformed tokens parse to none, never failures', () => {
		expect(Option.isNone(parseJwtClaims('not-a-jwt'))).toBe(true)
		expect(Option.isNone(parseJwtClaims('a.b'))).toBe(true)
		expect(Option.isNone(parseJwtClaims(`x.${Buffer.from('[1,2]').toString('base64url')}.y`))).toBe(true)
	})
})

describe('CodexAuth.get', () => {
	// Under it.effect the TestClock starts at epoch 0, so expiry arithmetic is deterministic:
	// a token expiring at 100s is valid (buffer 30s), one expiring at 10s is already expired.
	const validToken = new CodexTokenData({
		type: 'oauth',
		access: 'valid-access',
		refresh: 'valid-refresh',
		expires: 100_000,
		accountId: 'acct_cached',
	})
	const expiredToken = new CodexTokenData({
		type: 'oauth',
		access: 'stale-access',
		refresh: 'stale-refresh',
		expires: 10_000,
		accountId: 'acct_old',
	})

	it.effect('returns the cached token without touching the network', () =>
		Effect.gen(function* () {
			const network = scriptedFetchLayer(() => {
				throw new Error('no network call expected')
			})
			const store = yield* storeWith(validToken)
			const auth = yield* makeCodexAuth({ store }).pipe(Effect.provide(network.layer))

			const token = yield* auth.get
			expect(token.access).toBe('valid-access')
			expect(network.requests).toHaveLength(0)
		}),
	)

	it.effect('fails NotAuthenticated when the store is empty', () =>
		Effect.gen(function* () {
			const network = scriptedFetchLayer(() => {
				throw new Error('no network call expected')
			})
			const store = yield* storeWith()
			const auth = yield* makeCodexAuth({ store }).pipe(Effect.provide(network.layer))

			const result = yield* auth.get.pipe(Effect.flip)
			expect(result._tag).toBe('CodexAuthError')
			expect(result.reason).toBe('NotAuthenticated')
			expect(result.message).toContain(store.path)
		}),
	)

	it.effect('refreshes an expired token, persists it, and preserves the account id', () =>
		Effect.gen(function* () {
			const network = scriptedFetchLayer((request) => {
				expect(request.url).toBe('https://auth.openai.com/oauth/token')
				const params = new URLSearchParams(request.body)
				expect(params.get('grant_type')).toBe('refresh_token')
				expect(params.get('refresh_token')).toBe('stale-refresh')
				expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')

				// No id_token and a non-JWT access token: the previous accountId must be preserved.
				return jsonResponse({
					access_token: 'fresh-access',
					refresh_token: 'fresh-refresh',
					expires_in: 3600,
				})
			})
			const store = yield* storeWith(expiredToken)
			const auth = yield* makeCodexAuth({ store }).pipe(Effect.provide(network.layer))

			const token = yield* auth.get
			expect(token.access).toBe('fresh-access')
			expect(token.refresh).toBe('fresh-refresh')
			expect(token.expires).toBe(3_600_000)
			expect(token.accountId).toBe('acct_old')

			const persisted = yield* store.load
			expect(Option.isSome(persisted)).toBe(true)
			if (Option.isSome(persisted)) expect(persisted.value.access).toBe('fresh-access')
		}),
	)

	it.effect('extracts the account id from a refreshed id_token', () =>
		Effect.gen(function* () {
			const network = scriptedFetchLayer(() =>
				jsonResponse({
					access_token: 'fresh-access',
					refresh_token: 'fresh-refresh',
					expires_in: 60,
					id_token: jwtWith({ chatgpt_account_id: 'acct_new' }),
				}),
			)
			const store = yield* storeWith(expiredToken)
			const auth = yield* makeCodexAuth({ store }).pipe(Effect.provide(network.layer))

			const token = yield* auth.get
			expect(token.accountId).toBe('acct_new')
		}),
	)

	it.effect('single-flights concurrent refreshes', () =>
		Effect.gen(function* () {
			const network = scriptedFetchLayer(() =>
				jsonResponse({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
			)
			const store = yield* storeWith(expiredToken)
			const auth = yield* makeCodexAuth({ store }).pipe(Effect.provide(network.layer))

			const [first, second] = yield* Effect.all([auth.get, auth.get], { concurrency: 2 })
			expect(first.access).toBe('fresh-access')
			expect(second.access).toBe('fresh-access')
			expect(network.requests).toHaveLength(1)
		}),
	)

	it.effect('a failed refresh surfaces RefreshFailed and keeps the stored credential', () =>
		Effect.gen(function* () {
			// 400 is not transient, so the issuer client does not retry and the failure is immediate.
			const network = scriptedFetchLayer(() => jsonResponse({ error: 'invalid_grant' }, 400))
			const store = yield* storeWith(expiredToken)
			const auth = yield* makeCodexAuth({ store }).pipe(Effect.provide(network.layer))

			const result = yield* auth.get.pipe(Effect.flip)
			expect(result.reason).toBe('RefreshFailed')

			const persisted = yield* store.load
			expect(Option.isSome(persisted)).toBe(true)
			if (Option.isSome(persisted)) expect(persisted.value.refresh).toBe('stale-refresh')
		}),
	)

	it.effect('logout clears the stored credential', () =>
		Effect.gen(function* () {
			const network = scriptedFetchLayer(() => {
				throw new Error('no network call expected')
			})
			const store = yield* storeWith(validToken)
			const auth = yield* makeCodexAuth({ store }).pipe(Effect.provide(network.layer))

			yield* auth.logout
			const persisted = yield* store.load
			expect(Option.isNone(persisted)).toBe(true)

			const result = yield* auth.get.pipe(Effect.flip)
			expect(result.reason).toBe('NotAuthenticated')
		}),
	)
})
