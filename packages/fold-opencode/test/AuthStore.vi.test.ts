import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'

import { makeOpenCodeAuthStore, OpenCodeAuthDocument, OpenCodeTokenData } from '../src/AuthStore'

const tempStorePath = (): string => join(mkdtempSync(join(tmpdir(), 'fold-opencode-store-')), 'auth.json')

const decodeDocument = Schema.decodeSync(Schema.fromJsonString(OpenCodeAuthDocument))

const token = new OpenCodeTokenData({
	type: 'oauth',
	access: 'access',
	refresh: 'refresh',
	expires: 42,
	metadata: { server: 'https://opencode.ai', accountID: 'acc', email: 'a@b.c' },
})

describe('OpenCodeAuthStore', () => {
	it.effect('round-trips a token and preserves other providers entries', () =>
		Effect.gen(function* () {
			const path = tempStorePath()
			writeFileSync(path, JSON.stringify({ codex: { type: 'oauth', nested: [1, null] } }))
			const store = makeOpenCodeAuthStore({ path })

			yield* store.save(token)
			const loaded = yield* store.load
			expect(Option.getOrUndefined(loaded)?.metadata?.accountID).toBe('acc')

			const document = decodeDocument(readFileSync(path, 'utf8'))
			expect(document['codex']).toEqual({ type: 'oauth', nested: [1, null] })
			expect(document['opencode']).toEqual({
				type: 'oauth',
				access: 'access',
				refresh: 'refresh',
				expires: 42,
				metadata: { server: 'https://opencode.ai', accountID: 'acc', email: 'a@b.c' },
			})

			yield* store.clear
			expect(decodeDocument(readFileSync(path, 'utf8'))['opencode']).toBeUndefined()
		}),
	)

	it.effect('loads nothing from a corrupt document and refuses to overwrite it', () =>
		Effect.gen(function* () {
			const path = tempStorePath()
			writeFileSync(path, '{ not json')
			const store = makeOpenCodeAuthStore({ path })

			expect(Option.isNone(yield* store.load)).toBe(true)
			const error = yield* Effect.flip(store.save(token))
			expect(error.reason).toBe('InvalidDocument')
			expect(readFileSync(path, 'utf8')).toBe('{ not json')
		}),
	)
})
