import { statSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { configureProvider, describeModelConfiguration, loadFoldConfig, starterConfigJsonc } from '../../src/index'
import { memoryFileSystem, tempDir } from '../TestHelpers'

it.effect('adds a provider and model without changing roles, profiles, or policy config', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const directory = yield* tempDir
			const path = join(directory, 'config.jsonc')
			yield* Effect.promise(() => Bun.write(path, starterConfigJsonc()))
			const before = yield* loadFoldConfig({ path })

			const updated = yield* configureProvider(
				{
					name: 'private-openai',
					kind: 'openai-compat',
					baseUrl: 'https://models.example.test/v1',
					apiKey: 'secret-value',
					model: 'company-model-1',
				},
				{ path },
			)
			const persisted = yield* loadFoldConfig({ path })

			expect(updated).toEqual(persisted)
			expect(persisted.roles).toEqual(before.roles)
			expect(persisted.profiles).toEqual(before.profiles)
			expect(persisted.compaction).toEqual(before.compaction)
			expect(persisted.stopConditions).toEqual(before.stopConditions)
			expect(persisted.providers['private-openai']).toEqual({
				kind: 'openai-compat',
				baseUrl: 'https://models.example.test/v1',
				apiKey: 'secret-value',
				configuredModels: ['company-model-1'],
			})
			expect(
				describeModelConfiguration(persisted).providers.find(({ name }) => name === 'private-openai')?.models,
			).toContain('company-model-1')
			expect(statSync(path).mode & 0o777).toBe(0o600)
		}),
	),
)

it.effect('updates a provider, retaining configured models when no new model is supplied', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const directory = yield* tempDir
			const path = join(directory, 'config.jsonc')
			const source = `{
			"providers": {
				"custom": {
					"kind": "openai-compat",
					"baseUrl": "https://old.example/v1",
					"apiKeyEnv": "OLD_KEY",
					"configuredModels": ["existing-model"]
				}
			},
			"roles": {
				"smart": { "provider": "custom", "model": "existing-model" },
				"fast": { "provider": "custom", "model": "existing-model" }
			}
		}`
			yield* Effect.promise(() => Bun.write(path, source))

			const updated = yield* configureProvider(
				{
					name: 'custom',
					kind: 'anthropic',
					baseUrl: 'https://new.example/v1',
					apiKey: 'new-key',
				},
				{ path },
			)

			expect(updated.providers.custom).toEqual({
				kind: 'anthropic',
				baseUrl: 'https://new.example/v1',
				apiKey: 'new-key',
				configuredModels: ['existing-model'],
			})
			expect(updated.roles.smart).toEqual({ provider: 'custom', model: 'existing-model' })
		}),
	),
)

it.effect('stores an API key environment variable name without resolving or persisting its value', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const directory = yield* tempDir
			const path = join(directory, 'config.jsonc')
			yield* Effect.promise(() => Bun.write(path, starterConfigJsonc()))

			const updated = yield* configureProvider(
				{
					name: 'openrouter',
					kind: 'openai-compat',
					baseUrl: 'https://openrouter.ai/api/v1',
					apiKeyEnv: 'OPENROUTER_API_KEY',
					model: 'anthropic/claude-sonnet-4',
				},
				{ path },
			)

			expect(updated.providers.openrouter).toEqual({
				kind: 'openai-compat',
				baseUrl: 'https://openrouter.ai/api/v1',
				apiKeyEnv: 'OPENROUTER_API_KEY',
				configuredModels: ['anthropic/claude-sonnet-4'],
			})
		}),
	),
)

it.effect('rejects supplying both inline and environment API key sources', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const directory = yield* tempDir
			const path = join(directory, 'config.jsonc')
			yield* Effect.promise(() => Bun.write(path, starterConfigJsonc()))

			const error = yield* configureProvider(
				{
					name: 'ambiguous',
					kind: 'anthropic',
					baseUrl: 'https://api.anthropic.com',
					apiKey: 'secret',
					apiKeyEnv: 'ANTHROPIC_API_KEY',
				},
				{ path },
			).pipe(Effect.flip)

			expect(error._tag).toBe('ProviderConfigurationValidationError')
		}),
	),
)

it.effect('adds OAuth profiles without an API key and supplies their default model', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const directory = yield* tempDir
			const path = join(directory, 'config.jsonc')
			yield* Effect.promise(() => Bun.write(path, starterConfigJsonc()))
			const updated = yield* configureProvider(
				{ name: 'work-codex', kind: 'codex', baseUrl: 'https://example.test' },
				{ path },
			)

			expect(updated.providers['work-codex']).toEqual({
				kind: 'codex',
				baseUrl: 'https://example.test',
				configuredModels: ['gpt-5.6-sol'],
			})
		}),
	),
)

it.effect('rejects accidental API keys for OAuth profiles before writing', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const directory = yield* tempDir
			const path = join(directory, 'config.jsonc')
			yield* Effect.promise(() => Bun.write(path, starterConfigJsonc()))
			const before = yield* Effect.promise(() => Bun.file(path).text())
			const error = yield* configureProvider(
				{ name: 'nope', kind: 'xai', baseUrl: 'https://api.x.ai/v1', apiKey: 'secret' },
				{ path },
			).pipe(Effect.flip)
			expect(error._tag).toBe('ProviderConfigurationKindError')
			expect(yield* Effect.promise(() => Bun.file(path).text())).toBe(before)
		}),
	),
)

it.effect('does not replace a malformed existing config', () =>
	Effect.gen(function* () {
		const fileSystem = memoryFileSystem({
			'/home/user/.fold/config.jsonc': '{ malformed',
		})
		const error = yield* configureProvider(
			{ name: 'custom', kind: 'anthropic', baseUrl: 'https://example.test', apiKey: 'secret' },
			{ foldHome: '/home/user/.fold', fileSystem },
		).pipe(Effect.flip)

		expect(error._tag).toBe('ConfigParseError')
	}),
)
