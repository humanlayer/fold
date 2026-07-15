/**
 * JSON Schema generation + `configInit` tests (D25): the schema is generated from the same FoldConfig
 * schema that decodes the file (draft-07, self-contained), the starter config is valid against that
 * schema (it round-trips through the loader), and `configInit` writes both files without clobbering an
 * existing config. All filesystem work is over an in-memory FileSystem.
 */
import { expect, it } from '@effect/vitest'
import { Effect, JsonSchema } from 'effect'

import {
	configInit,
	parseFoldConfig,
	starterConfigJsonc,
	foldConfigJsonSchema,
	foldConfigJsonSchemaText,
} from '../../src/index'
import { memoryFileFor, memoryFileSystem } from '../TestHelpers'

it('generates a self-contained draft-07 schema with the config properties', () => {
	const schema = foldConfigJsonSchema()

	expect(schema.$schema).toBe(JsonSchema.META_SCHEMA_URI_DRAFT_07)
	// Identified schemas become named definitions; the root refers to FoldConfig.
	expect(schema.$ref).toBe('#/definitions/FoldConfig')

	const text = foldConfigJsonSchemaText()
	expect(text.endsWith('\n')).toBe(true)
	// The named definitions cover the config's reused shapes.
	expect(text).toContain('FoldConfig')
	expect(text).toContain('ProviderConnection')
	expect(text).toContain('RoleBinding')
	expect(text).toContain('providers')
	expect(text).toContain('roles')
	expect(text).toContain('compaction')
	expect(text).toContain('stopConditions')
	// Serializes as valid JSON.
	expect(() => JSON.parse(text)).not.toThrow()
})

it.effect('the starter config is valid against the schema (round-trips through the loader)', () =>
	Effect.gen(function* () {
		const config = yield* parseFoldConfig(starterConfigJsonc())

		expect(config.roles.smart).toMatchObject({
			provider: 'codex',
			model: 'gpt-5.6-sol',
			reasoning: 'medium',
		})
		expect(config.providers.codex?.kind).toBe('codex')
		expect(config.providers.opencode?.kind).toBe('opencode')
		expect(config.providers.xai?.kind).toBe('xai')
		expect(config.compaction?.enabled).toBe(true)
		expect(config.stopConditions?.doomLoop?.enabled).toBe(true)
		expect(config.$schema).toBe('./config.schema.json')

		// The starter pins the default primary model while the orchestrator demonstrates Codex's
		// provider-kind default and fast keeps an explicit Anthropic model example.
		expect(config.roles.orchestrator?.provider).toBe('codex')
		expect(config.roles.orchestrator?.model).toBeUndefined()
		expect(config.roles.fast.model).toBe('claude-haiku-4-5-20251001')
	}),
)

it.effect('configInit writes the schema and a starter config, then never clobbers the config', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({})

		const first = yield* configInit({ foldHome: '/home/user/.fold', fileSystem: fs })
		expect(first.createdConfig).toBe(true)
		expect(first.configPath).toBe('/home/user/.fold/config.jsonc')
		expect(first.schemaPath).toBe('/home/user/.fold/config.schema.json')
		// The bootstrap also lands an EMPTY provider-keyed auth store (filled later by codex login).
		expect(first.createdAuth).toBe(true)
		expect(first.authPath).toBe('/home/user/.fold/auth.json')
		expect(yield* memoryFileFor(fs, first.authPath)).toBe('{}\n')

		const schemaFile = yield* memoryFileFor(fs, first.schemaPath)
		expect(schemaFile).not.toBeNull()
		expect(schemaFile ?? '').toContain(JsonSchema.META_SCHEMA_URI_DRAFT_07)

		// A user edits their config and logs in; a second init refreshes the generated files but leaves both alone.
		yield* fs.writeFileString('/home/user/.fold/config.jsonc', '{ "edited": true }').pipe(Effect.orDie)
		yield* fs.writeFileString('/home/user/.fold/auth.json', '{ "codex": { "access": "tok" } }').pipe(Effect.orDie)
		const second = yield* configInit({ foldHome: '/home/user/.fold', fileSystem: fs })
		expect(second.createdConfig).toBe(false)
		expect(second.createdAuth).toBe(false)

		const configFile = yield* memoryFileFor(fs, second.configPath)
		expect(configFile).toBe('{ "edited": true }')
		expect(yield* memoryFileFor(fs, second.authPath)).toBe('{ "codex": { "access": "tok" } }')
	}),
)
