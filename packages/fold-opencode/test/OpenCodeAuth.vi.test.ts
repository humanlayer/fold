import { describe, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { expect } from 'vitest'

import type { OpenCodeAuthStore } from '../src/AuthStore'
import { makeOpenCodeAuth } from '../src/OpenCodeAuth'

const response = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown) =>
	HttpClientResponse.fromWeb(
		request,
		new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
	)
describe('OpenCode device OAuth', () => {
	it.effect('polls, resolves account metadata, and persists the credential', () => {
		const saved: Array<string> = []
		const paths: Array<string> = []
		let polls = 0
		const store: OpenCodeAuthStore = {
			path: '/tmp/auth.json',
			load: Effect.succeed(Option.none()),
			save: (token) =>
				Effect.sync(() => {
					saved.push(token.access)
					return token
				}),
			clear: Effect.void,
		}
		const client = HttpClient.make((request) =>
			Effect.sync(() => {
				const path = new URL(request.url).pathname
				paths.push(path)
				if (path === '/auth/device/code')
					return response(request, {
						device_code: 'device',
						user_code: 'ABCD',
						verification_uri_complete: '/activate',
						expires_in: 600,
						interval: 0,
					})
				if (path === '/auth/device/token') {
					polls += 1
					return response(
						request,
						polls === 1
							? { error: 'authorization_pending' }
							: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 },
					)
				}
				if (path === '/api/user') return response(request, { id: 'user-1', email: 'u@example.com' })
				return response(request, [
					{ id: 'org-z', name: 'Zulu' },
					{ id: 'org-a', name: 'Alpha' },
				])
			}),
		)
		return Effect.gen(function* () {
			const auth = yield* makeOpenCodeAuth({
				store,
				server: 'https://console.test',
				onDeviceCode: ({ url, userCode }) =>
					Effect.sync(() => {
						expect(url).toBe('https://console.test/activate')
						expect(userCode).toBe('ABCD')
					}),
			})
			const token = yield* auth.authenticateDevice
			expect(token.metadata?.orgID).toBe('org-a')
			expect(saved).toEqual(['access'])
			expect(paths).toEqual([
				'/auth/device/code',
				'/auth/device/token',
				'/auth/device/token',
				'/api/user',
				'/api/orgs',
			])
		}).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, client)))
	})
})
