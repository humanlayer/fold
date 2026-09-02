import { readdir, rm } from 'node:fs/promises'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'

import {
	buildXaiAuthorizeUrl,
	DEFAULT_XAI_MODEL_ID,
	makeXaiAuthStore,
	normalizeXaiChatCompletionUsage,
	XAI_FRONTIER_MODELS,
	XAI_BROWSER_REDIRECT_URI,
	XAI_CLIENT_ID,
	xaiModel,
	XaiFrontierModelId,
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
			const store = yield* makeXaiAuthStore({ path })
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
			Effect.provide(NodeFileSystem.layer),
		),
	)
})

describe('xaiModel', () => {
	it('normalizes xAI text-only completion tokens for the OpenAI-compatible adapter', () => {
		expect(
			normalizeXaiChatCompletionUsage({
				prompt_tokens: 641,
				completion_tokens: 1,
				total_tokens: 889,
				prompt_tokens_details: { cached_tokens: 512 },
				completion_tokens_details: { reasoning_tokens: 247 },
			}),
		).toMatchObject({
			prompt_tokens: 641,
			completion_tokens: 248,
			total_tokens: 889,
			completion_tokens_details: { reasoning_tokens: 247 },
		})
	})

	it('normalizes xAI usage independently of the aggregate total', () => {
		const usage = {
			prompt_tokens: 10,
			completion_tokens: 8,
			total_tokens: 18,
			completion_tokens_details: { reasoning_tokens: 3 },
		}

		expect(normalizeXaiChatCompletionUsage(usage)).toEqual({
			...usage,
			completion_tokens: 11,
		})
	})

	it('exports the supported frontier catalog and defaults to its newest model', () => {
		expect(XAI_FRONTIER_MODELS).toEqual([
			{ modelId: 'grok-4.5', label: 'Grok 4.5' },
			{ modelId: 'grok-4.6', label: 'Grok 4.6' },
		])
		expect(XAI_FRONTIER_MODELS.at(-1)?.modelId).toBe(DEFAULT_XAI_MODEL_ID)
		expect(Schema.is(XaiFrontierModelId)('grok-4.5')).toBe(true)
		expect(Schema.is(XaiFrontierModelId)('grok-4.6')).toBe(true)
		expect(Schema.is(XaiFrontierModelId)('grok-unverified')).toBe(false)
	})

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
