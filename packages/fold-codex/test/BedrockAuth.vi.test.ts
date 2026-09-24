import { describe, expect, it } from '@effect/vitest'
import type { AwsCredentialIdentityProvider } from '@smithy/types'
import { Effect, Fiber, Option, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

import { makeBedrockAuth, withBedrockAuth } from '../src/index'

const credentials =
	(expiration?: Date): AwsCredentialIdentityProvider =>
	async () => {
		const identity: { accessKeyId: string; secretAccessKey: string; expiration?: Date } = {
			accessKeyId: 'test-access-key',
			secretAccessKey: 'test-secret-key',
		}
		if (expiration !== undefined) identity.expiration = expiration
		return identity
	}

describe('BedrockAuth', () => {
	it.effect('generates once and reuses the cached token before refreshAt', () =>
		Effect.gen(function* () {
			let generations = 0
			const auth = yield* makeBedrockAuth({
				region: 'us-east-1',
				credentialProviderFactory: () => credentials(),
				generateToken: async () => `token-${++generations}`,
			})
			expect(yield* auth.getToken).toBe('token-1')
			expect(yield* auth.getToken).toBe('token-1')
			expect(generations).toBe(1)
		}),
	)

	it.effect('refreshes after the buffered lifetime and honors earlier AWS credential expiry', () =>
		Effect.gen(function* () {
			let generations = 0
			const auth = yield* makeBedrockAuth({
				region: 'us-east-1',
				credentialProviderFactory: () => credentials(new Date(10 * 60 * 1000)),
				generateToken: async () => `token-${++generations}`,
			})
			expect(yield* auth.getToken).toBe('token-1')
			yield* TestClock.adjust(299_000)
			expect(yield* auth.getToken).toBe('token-1')
			yield* TestClock.adjust('1 second')
			expect(yield* auth.getToken).toBe('token-2')
			expect(generations).toBe(2)
		}),
	)

	it.effect('single-flights concurrent token generation', () =>
		Effect.gen(function* () {
			let generations = 0
			const auth = yield* makeBedrockAuth({
				region: 'us-east-1',
				credentialProviderFactory: () => credentials(),
				generateToken: async () => `token-${++generations}`,
			})
			const tokens = yield* Effect.all([auth.getToken, auth.getToken], { concurrency: 2 })
			expect(tokens).toEqual(['token-1', 'token-1'])
			expect(generations).toBe(1)
		}),
	)

	it.effect('refresh failures expose no AWS credential values', () =>
		Effect.gen(function* () {
			const auth = yield* makeBedrockAuth({
				region: 'us-east-1',
				credentialProviderFactory: () => async () => {
					throw new Error('test-access-key test-secret-key')
				},
				generateToken: async () => 'unused',
			})
			const error = yield* auth.getToken.pipe(Effect.flip)
			const rendered = JSON.stringify(error)
			expect(rendered).not.toContain('test-access-key')
			expect(rendered).not.toContain('test-secret-key')
			expect(error.reason).toBe('CredentialsUnavailable')
		}),
	)

	it.effect('invalidation during refresh cannot republish the pre-invalidation token or provider', () =>
		Effect.gen(function* () {
			let providers = 0
			let generations = 0
			let resolveFirstToken: ((token: string) => void) | undefined
			let signalFirstGeneration: (() => void) | undefined
			const firstGenerationStarted = new Promise<void>((resolve) => {
				signalFirstGeneration = resolve
			})
			const firstToken = new Promise<string>((resolve) => {
				resolveFirstToken = resolve
			})
			const auth = yield* makeBedrockAuth({
				region: 'us-east-1',
				credentialProviderFactory: () => {
					providers += 1
					return credentials()
				},
				generateToken: () => {
					generations += 1
					if (generations === 1) {
						signalFirstGeneration?.()
						return firstToken
					}
					return Promise.resolve('fresh-token')
				},
			})

			const tokenFiber = yield* auth.getToken.pipe(Effect.forkChild)
			yield* Effect.promise(() => firstGenerationStarted)
			yield* auth.invalidate
			yield* Effect.sync(() => resolveFirstToken?.('stale-token'))

			expect(yield* Fiber.join(tokenFiber)).toBe('fresh-token')
			expect(yield* auth.getToken).toBe('fresh-token')
			expect(generations).toBe(2)
			expect(providers).toBe(2)
		}),
	)
})

describe('withBedrockAuth', () => {
	it.effect('invalidates, rebuilds headers, and retries one qualifying auth response', () =>
		Effect.gen(function* () {
			const authorizations: Array<string | undefined> = []
			const chatGptHeaders: Array<string | undefined> = []
			let requests = 0
			const client = HttpClient.make((request) => {
				authorizations.push(request.headers.authorization)
				chatGptHeaders.push(request.headers['chatgpt-account-id'])
				requests += 1
				return Effect.succeed(
					HttpClientResponse.fromWeb(request, new Response('', { status: requests === 1 ? 401 : 200 })),
				)
			})

			let providers = 0
			let generations = 0
			const auth = yield* makeBedrockAuth({
				region: 'us-east-1',
				credentialProviderFactory: () => {
					providers += 1
					return credentials()
				},
				generateToken: async () => `token-${++generations}`,
			})
			const response = yield* withBedrockAuth(client, auth).execute(HttpClientRequest.get('https://example.test'))

			expect(response.status).toBe(200)
			expect(authorizations).toEqual(['Bearer token-1', 'Bearer token-2'])
			expect(chatGptHeaders).toEqual([undefined, undefined])
			expect(providers).toBe(2)
			expect(requests).toBe(2)
		}),
	)

	it.effect('returns a second authentication failure without retrying again', () =>
		Effect.gen(function* () {
			let requests = 0
			const client = HttpClient.make((request) => {
				requests += 1
				return Effect.succeed(
					HttpClientResponse.fromWeb(request, new Response('{"code":"ExpiredToken"}', { status: 403 })),
				)
			})
			let generations = 0
			const auth = yield* makeBedrockAuth({
				region: 'us-east-1',
				credentialProviderFactory: () => credentials(),
				generateToken: async () => `token-${++generations}`,
			})
			const response = yield* withBedrockAuth(client, auth).execute(HttpClientRequest.get('https://example.test'))
			expect(response.status).toBe(403)
			expect(requests).toBe(2)
			expect(generations).toBe(2)
		}),
	)

	it.effect('bounds 403 inspection without consuming or awaiting the original non-terminating body', () =>
		Effect.gen(function* () {
			let pulls = 0
			const endlessBody = new ReadableStream<Uint8Array>({
				pull: (controller) => {
					pulls += 1
					if (pulls === 1) controller.enqueue(new Uint8Array(16_384).fill(65))
					return pulls === 1 ? undefined : new Promise<void>(() => undefined)
				},
			})
			const client = HttpClient.make((request) =>
				Effect.succeed(HttpClientResponse.fromWeb(request, new Response(endlessBody, { status: 403 }))),
			)
			const auth = yield* makeBedrockAuth({
				region: 'us-east-1',
				credentialProviderFactory: () => credentials(),
				generateToken: async () => 'token',
			})

			const response = yield* withBedrockAuth(client, auth).execute(HttpClientRequest.get('https://example.test'))
			expect(response.status).toBe(403)
			const firstOriginalChunk = yield* Stream.runHead(response.stream)
			expect(Option.isSome(firstOriginalChunk) && firstOriginalChunk.value.byteLength).toBe(16_384)
		}),
	)
})
