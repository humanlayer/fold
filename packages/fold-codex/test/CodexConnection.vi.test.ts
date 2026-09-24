import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { describe, expect, it } from '@effect/vitest'
import { Effect, FileSystem, PlatformError } from 'effect'

import {
	CodexBedrockAuthData,
	makeCodexBedrockAuthStore,
	readCodexAmazonBedrockConfig,
	resolveCodexConnection,
} from '../src/index'

const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), 'fold-codex-connection-'))
	const authPath = join(root, 'auth.json')
	const codexHome = join(root, 'codex')
	mkdirSync(codexHome)
	return { authPath, codexHome }
}

const region = () => Effect.succeed('us-west-2')

describe('resolveCodexConnection', () => {
	it.effect('explicit Bedrock wins and maps the regional endpoint and wire model', () =>
		resolveCodexConnection({
			logicalModel: 'gpt-5.6-sol',
			connection: { type: 'bedrock', profile: 'work' },
			resolveRegion: region,
		}).pipe(
			Effect.map((resolved) => {
				expect(resolved).toEqual({
					type: 'bedrock',
					profile: 'work',
					region: 'us-west-2',
					model: 'openai.gpt-5.6-sol',
					baseUrl: 'https://bedrock-mantle.us-west-2.api.aws/openai/v1',
				})
				return resolved
			}),
			Effect.provide(NodeFileSystem.layer),
		),
	)

	it.effect('keeps a custom Responses base URL in base form', () =>
		resolveCodexConnection({
			logicalModel: 'gpt-5.6-sol',
			connection: {
				type: 'bedrock',
				region: 'us-east-1',
				baseUrl: 'https://bedrock.example.test/openai/v1/',
			},
		}).pipe(
			Effect.map((resolved) => {
				expect(resolved.type === 'bedrock' && resolved.baseUrl).toBe('https://bedrock.example.test/openai/v1')
			}),
			Effect.provide(NodeFileSystem.layer),
		),
	)

	it.effect('normalizes a full Responses endpoint to the client base URL', () =>
		resolveCodexConnection({
			logicalModel: 'gpt-5.6-sol',
			connection: {
				type: 'bedrock',
				region: 'us-east-1',
				baseUrl: 'https://bedrock.example.test/openai/v1/responses/',
			},
		}).pipe(
			Effect.map((resolved) => {
				expect(resolved.type === 'bedrock' && resolved.baseUrl).toBe('https://bedrock.example.test/openai/v1')
			}),
			Effect.provide(NodeFileSystem.layer),
		),
	)

	it.effect('active true selects saved Bedrock configuration', () =>
		Effect.gen(function* () {
			const { authPath, codexHome } = fixture()
			const store = yield* makeCodexBedrockAuthStore({ path: authPath })
			yield* store.save(
				new CodexBedrockAuthData({
					type: 'aws-profile',
					active: true,
					region: 'eu-west-1',
					model: 'openai.saved',
				}),
			)
			const resolved = yield* resolveCodexConnection({ logicalModel: 'logical', codexHome, bedrockStore: store })
			expect(resolved.type).toBe('bedrock')
			if (resolved.type === 'bedrock') expect(resolved.model).toBe('openai.saved')
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	)

	it.effect('active false forces ChatGPT even when Codex TOML selects Bedrock', () =>
		Effect.gen(function* () {
			const { authPath, codexHome } = fixture()
			writeFileSync(
				join(codexHome, 'config.toml'),
				'model_provider = "amazon-bedrock"\n[model_providers.amazon-bedrock.aws]\nregion = "us-east-1"\n',
			)
			const store = yield* makeCodexBedrockAuthStore({ path: authPath })
			yield* store.save(new CodexBedrockAuthData({ type: 'aws-profile', active: false }))
			const resolved = yield* resolveCodexConnection({ logicalModel: 'logical', codexHome, bedrockStore: store })
			expect(resolved).toEqual({ type: 'chatgpt' })
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	)

	it.effect('Codex TOML selects Bedrock when there is no active marker', () =>
		Effect.gen(function* () {
			const { authPath, codexHome } = fixture()
			writeFileSync(
				join(codexHome, 'config.toml'),
				[
					'model_provider = "amazon-bedrock"',
					'model = "openai.from-config"',
					'[model_providers.amazon-bedrock]',
					'base_url = "https://bedrock.example.test/openai/v1"',
					'[model_providers.amazon-bedrock.aws]',
					'profile = "work"',
					'region = "us-east-1"',
				].join('\n'),
			)
			const store = yield* makeCodexBedrockAuthStore({ path: authPath })
			const resolved = yield* resolveCodexConnection({ logicalModel: 'logical', codexHome, bedrockStore: store })
			expect(resolved).toEqual({
				type: 'bedrock',
				profile: 'work',
				region: 'us-east-1',
				model: 'openai.from-config',
				baseUrl: 'https://bedrock.example.test/openai/v1',
			})
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	)

	it.effect('missing config falls back to ChatGPT and explicit invalid Bedrock fails closed', () =>
		Effect.gen(function* () {
			const { authPath, codexHome } = fixture()
			const store = yield* makeCodexBedrockAuthStore({ path: authPath })
			expect(yield* resolveCodexConnection({ logicalModel: 'logical', codexHome, bedrockStore: store })).toEqual({
				type: 'chatgpt',
			})
			const error = yield* resolveCodexConnection({
				logicalModel: 'logical',
				connection: { type: 'bedrock', baseUrl: 'http://not-loopback.test' },
				resolveRegion: region,
			}).pipe(Effect.flip)
			expect(error.reason).toBe('InvalidConfiguration')
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	)

	it.effect('non-not-found Codex config read failures propagate instead of selecting ChatGPT', () =>
		Effect.gen(function* () {
			const permissionDenied = PlatformError.systemError({
				_tag: 'PermissionDenied',
				module: 'FileSystem',
				method: 'readFileString',
				pathOrDescriptor: '/protected/config.toml',
			})
			const fileSystem = FileSystem.makeNoop({
				readFileString: () => Effect.fail(permissionDenied),
			})
			const error = yield* readCodexAmazonBedrockConfig({ codexHome: '/protected' }).pipe(
				Effect.provideService(FileSystem.FileSystem, fileSystem),
				Effect.flip,
			)
			expect(error.reason).toBe('ReadFailed')
		}),
	)
})
