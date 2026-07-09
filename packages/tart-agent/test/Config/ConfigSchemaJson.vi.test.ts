/**
 * JSON Schema generation + `configInit` tests (D25): the schema is generated from the same TartConfig
 * schema that decodes the file (draft-07, self-contained), the starter config is valid against that
 * schema (it round-trips through the loader), and `configInit` writes both files without clobbering an
 * existing config. All filesystem work is over an in-memory FileSystem.
 */
import { expect, it } from '@effect/vitest'
import { Effect, JsonSchema } from 'effect'

import {
	configInit,
	parseTartConfig,
	starterConfigJsonc,
	tartConfigJsonSchema,
	tartConfigJsonSchemaText,
} from '../../src/index'
import { memoryFileFor, memoryFileSystem } from '../TestHelpers'

it('generates a self-contained draft-07 schema with the config properties', () => {
	const schema = tartConfigJsonSchema()

	expect(schema.$schema).toBe(JsonSchema.META_SCHEMA_URI_DRAFT_07)
	// Identified schemas become named definitions; the root refers to TartConfig.
	expect(schema.$ref).toBe('#/definitions/TartConfig')

	const text = tartConfigJsonSchemaText()
	expect(text.endsWith('\n')).toBe(true)
	// The named definitions cover the config's reused shapes.
	expect(text).toContain('TartConfig')
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
		const config = yield* parseTartConfig(starterConfigJsonc())

		expect(config.roles.smart.provider).toBe('anthropic')
		expect(config.providers.codex?.kind).toBe('codex')
		expect(config.compaction?.enabled).toBe(false)
		expect(config.stopConditions?.doomLoop?.enabled).toBe(true)
		expect(config.$schema).toBe('./config.schema.json')
	}),
)

it.effect('configInit writes the schema and a starter config, then never clobbers the config', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({})

		const first = yield* configInit({ tartHome: '/home/user/.tart', fileSystem: fs })
		expect(first.createdConfig).toBe(true)
		expect(first.configPath).toBe('/home/user/.tart/config.jsonc')
		expect(first.schemaPath).toBe('/home/user/.tart/config.schema.json')

		const schemaFile = yield* memoryFileFor(fs, first.schemaPath)
		expect(schemaFile).not.toBeNull()
		expect(schemaFile ?? '').toContain(JsonSchema.META_SCHEMA_URI_DRAFT_07)

		// A user edits their config; a second init refreshes the schema but leaves the config untouched.
		yield* fs.writeFileString('/home/user/.tart/config.jsonc', '{ "edited": true }').pipe(Effect.orDie)
		const second = yield* configInit({ tartHome: '/home/user/.tart', fileSystem: fs })
		expect(second.createdConfig).toBe(false)

		const configFile = yield* memoryFileFor(fs, second.configPath)
		expect(configFile).toBe('{ "edited": true }')
	}),
)
