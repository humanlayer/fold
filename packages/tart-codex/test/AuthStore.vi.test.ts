import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'

import { CodexTokenData, makeCodexAuthStore, TOKEN_EXPIRY_BUFFER_MS } from '../src/index'

const tempStorePath = (): string => join(mkdtempSync(join(tmpdir(), 'tart-codex-store-')), 'auth.json')

const decodeDocument = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

const readDocument = (path: string): Record<string, unknown> => {
	const document = decodeDocument(readFileSync(path, 'utf8'))
	if (Option.isNone(document)) throw new Error(`invalid auth document at ${path}`)
	return document.value
}

const sampleToken = new CodexTokenData({
	type: 'oauth',
	access: 'access-token-1',
	refresh: 'refresh-token-1',
	expires: 1_000_000,
	accountId: 'acct_123',
})

describe('CodexAuthStore', () => {
	it.effect('load returns none for a missing store', () =>
		Effect.gen(function* () {
			const store = makeCodexAuthStore({ path: tempStorePath() })
			const loaded = yield* store.load
			expect(Option.isNone(loaded)).toBe(true)
		}),
	)

	it.effect('save/load round-trips and forces 0600 permissions', () =>
		Effect.gen(function* () {
			const path = tempStorePath()
			const store = makeCodexAuthStore({ path })

			yield* store.save(sampleToken)
			const loaded = yield* store.load

			expect(Option.isSome(loaded)).toBe(true)
			if (Option.isSome(loaded)) {
				expect(loaded.value.access).toBe('access-token-1')
				expect(loaded.value.refresh).toBe('refresh-token-1')
				expect(loaded.value.expires).toBe(1_000_000)
				expect(loaded.value.accountId).toBe('acct_123')
			}

			expect(statSync(path).mode & 0o777).toBe(0o600)
		}),
	)

	it.effect('save preserves other providers entries in the document', () =>
		Effect.gen(function* () {
			const path = tempStorePath()
			writeFileSync(path, JSON.stringify({ anthropic: { type: 'api', key: 'sk-other' } }))

			const store = makeCodexAuthStore({ path })
			yield* store.save(sampleToken)

			const document = readDocument(path)
			expect(document['anthropic']).toEqual({ type: 'api', key: 'sk-other' })
			expect(document['codex']).toMatchObject({ access: 'access-token-1' })
		}),
	)

	it.effect('clear removes only the codex entry', () =>
		Effect.gen(function* () {
			const path = tempStorePath()
			writeFileSync(path, JSON.stringify({ anthropic: { type: 'api', key: 'sk-other' } }))

			const store = makeCodexAuthStore({ path })
			yield* store.save(sampleToken)
			yield* store.clear

			const document = readDocument(path)
			expect(document['codex']).toBeUndefined()
			expect(document['anthropic']).toEqual({ type: 'api', key: 'sk-other' })

			const loaded = yield* store.load
			expect(Option.isNone(loaded)).toBe(true)
		}),
	)

	it.effect('corrupt JSON degrades to no credentials without clobbering the file', () =>
		Effect.gen(function* () {
			const path = tempStorePath()
			writeFileSync(path, 'not json at all {')

			const store = makeCodexAuthStore({ path })
			const loaded = yield* store.load

			expect(Option.isNone(loaded)).toBe(true)
			expect(readFileSync(path, 'utf8')).toBe('not json at all {')
		}),
	)

	it.effect('an invalid codex entry is skipped, not decoded', () =>
		Effect.gen(function* () {
			const path = tempStorePath()
			writeFileSync(path, JSON.stringify({ codex: { type: 'api', key: 'wrong-shape' } }))

			const store = makeCodexAuthStore({ path })
			const loaded = yield* store.load
			expect(Option.isNone(loaded)).toBe(true)
		}),
	)

	it('isExpired applies the 30s safety buffer', () => {
		const token = new CodexTokenData({ type: 'oauth', access: 'a', refresh: 'r', expires: 100_000 })
		expect(token.isExpired(100_000 - TOKEN_EXPIRY_BUFFER_MS - 1)).toBe(false)
		expect(token.isExpired(100_000 - TOKEN_EXPIRY_BUFFER_MS)).toBe(false)
		expect(token.isExpired(100_000 - TOKEN_EXPIRY_BUFFER_MS + 1)).toBe(true)
		expect(token.isExpired(100_000)).toBe(true)
	})
})
