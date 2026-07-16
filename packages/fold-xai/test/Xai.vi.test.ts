import { readdir, rm } from 'node:fs/promises'

import { describe, expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import {
	buildXaiAuthorizeUrl,
	DEFAULT_XAI_MODEL_ID,
	makeXaiAuthStore,
	XAI_BROWSER_REDIRECT_URI,
	XAI_CLIENT_ID,
	xaiModel,
	XaiTokenData,
} from '../src/index'

describe('xAI OAuth', () => {
	it('builds the registered PKCE authorization request', () => {
		const url = new URL(buildXaiAuthorizeUrl({ verifier: 'verifier', challenge: 'challenge' }, 'state', 'nonce'))
		expect(url.origin).toBe('https://auth.x.ai')
		expect(url.searchParams.get('client_id')).toBe(XAI_CLIENT_ID)
		expect(url.searchParams.get('redirect_uri')).toBe(XAI_BROWSER_REDIRECT_URI)
		expect(url.searchParams.get('code_challenge_method')).toBe('S256')
		expect(url.searchParams.get('plan')).toBe('generic')
		expect(url.searchParams.get('referrer')).toBe('fold')
	})

	it.effect('persists xAI tokens under its provider key and clears without losing peers', () =>
		Effect.gen(function* () {
			const path = `${process.cwd()}/.tmp-xai-auth-${crypto.randomUUID()}.json`
			const store = makeXaiAuthStore({ path })
			const token = new XaiTokenData({ type: 'oauth', access: 'access', refresh: 'refresh', expires: 42 })
			yield* store.save(token)
			const loaded = yield* store.load
			expect(Option.getOrUndefined(loaded)?.access).toBe('access')
			yield* store.clear
			expect(Option.isNone(yield* store.load)).toBe(true)
		}).pipe(
			Effect.ensuring(
				Effect.promise(async () => {
					const files = (await readdir(process.cwd())).filter((file) => file.startsWith('.tmp-xai-auth-'))
					await Promise.all(files.map((file) => rm(file, { force: true })))
				}),
			),
		),
	)
})

describe('xaiModel', () => {
	it('returns a FoldModel-compatible OpenAI snapshot', () => {
		const model = xaiModel()
		expect(model.activeModel).toMatchObject({
			providerId: 'xai',
			providerKind: 'openai-compatible',
			modelId: DEFAULT_XAI_MODEL_ID,
		})
		expect(model.provider._tag).toBe('custom')
	})
})
