/**
 * TartConfig loading tests (D25): the string-aware JSONC stripper, schema decoding with unknown-key
 * rejection and role/provider cross-reference validation, and filesystem loading over an in-memory
 * FileSystem (never touches the real disk).
 */
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { loadTartConfig, loadTartConfigOrNull, parseTartConfig, stripJsonc } from '../../src/index'
import { memoryFileSystem } from '../TestHelpers'

const validConfig = `{
	// leading comment
	"$schema": "./config.schema.json",
	"providers": {
		"anthropic": { "kind": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" }, /* block */
		"codex": { "kind": "codex" },
	},
	"roles": {
		"smart": { "provider": "anthropic", "model": "claude-opus-4-8", "reasoning": "medium" },
		"fast": { "provider": "codex", "model": "gpt-5.5" },
	},
	"compaction": { "enabled": true, "thresholdTokens": 240000, "reserveTokens": 16000 },
	"stopConditions": { "doomLoop": { "enabled": true, "repeatedToolCalls": 3 } },
}
`

it('stripJsonc removes comments and trailing commas without touching string contents', () => {
	const input = '{ "url": "http://x//y", "arr": ["a,]", ], /* c */ "n": 1, }'
	const stripped = stripJsonc(input)
	const parsed: unknown = JSON.parse(stripped)

	expect(parsed).toEqual({ url: 'http://x//y', arr: ['a,]'], n: 1 })
})

it.effect('decodes a valid JSONC config (comments + trailing commas)', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(validConfig)

		expect(config.providers.anthropic?.kind).toBe('anthropic')
		expect(config.providers.codex?.kind).toBe('codex')
		expect(config.roles.smart.model).toBe('claude-opus-4-8')
		expect(config.roles.smart.reasoning).toBe('medium')
		expect(config.roles.fast.provider).toBe('codex')
		expect(config.compaction?.enabled).toBe(true)
		expect(config.stopConditions?.doomLoop?.enabled).toBe(true)
	}),
)

it.effect('rejects an unknown top-level key (typo safety)', () =>
	Effect.gen(function* () {
		const text = `{ "providers": {}, "roles": { "smart": { "provider": "a", "model": "m" }, "fast": { "provider": "a", "model": "m" } }, "typo": true }`
		const error = yield* parseTartConfig(text).pipe(Effect.flip)

		expect(error._tag).toBe('ConfigDecodeError')
	}),
)

it.effect('rejects a role that references an undeclared provider (cross-reference check)', () =>
	Effect.gen(function* () {
		const text = `{
			"providers": { "anthropic": { "kind": "anthropic", "apiKeyEnv": "K" } },
			"roles": {
				"smart": { "provider": "anthropic", "model": "m" },
				"fast": { "provider": "missing", "model": "m" }
			}
		}`
		const error = yield* parseTartConfig(text).pipe(Effect.flip)

		expect(error._tag).toBe('ConfigDecodeError')
		if (error._tag === 'ConfigDecodeError') expect(error.message).toContain('missing')
	}),
)

it.effect('fails with ConfigParseError on malformed JSON', () =>
	Effect.gen(function* () {
		const error = yield* parseTartConfig('{ "providers": }').pipe(Effect.flip)
		expect(error._tag).toBe('ConfigParseError')
	}),
)

it.effect('loads and decodes the config file from the tart home', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({ '/home/user/.tart/config.jsonc': validConfig })
		const config = yield* loadTartConfig({ tartHome: '/home/user/.tart', fileSystem: fs })

		expect(config.roles.smart.model).toBe('claude-opus-4-8')
	}),
)

it.effect('fails with ConfigFileNotFoundError when the file is absent; OrNull returns null', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({})
		const error = yield* loadTartConfig({ tartHome: '/home/user/.tart', fileSystem: fs }).pipe(Effect.flip)
		expect(error._tag).toBe('ConfigFileNotFoundError')

		const orNull = yield* loadTartConfigOrNull({ tartHome: '/home/user/.tart', fileSystem: fs })
		expect(orNull).toBeNull()
	}),
)
