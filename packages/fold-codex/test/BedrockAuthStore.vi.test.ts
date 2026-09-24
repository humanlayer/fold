import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { describe, expect, it } from '@effect/vitest'
import { Effect, FileSystem, Option, PlatformError, Schema } from 'effect'

import { CodexBedrockAuthData, CodexTokenData, makeCodexAuthStore, makeCodexBedrockAuthStore } from '../src/index'

const tempStorePath = (): string => join(mkdtempSync(join(tmpdir(), 'fold-bedrock-store-')), 'auth.json')
const AuthDocument = Schema.Record(Schema.String, Schema.Unknown)
const readDocument = (path: string) => Schema.decodeUnknownEffect(AuthDocument)(JSON.parse(readFileSync(path, 'utf8')))

describe('CodexBedrockAuthStore', () => {
	it.effect('save/load/clear preserves codex and unrelated providers', () =>
		Effect.gen(function* () {
			const path = tempStorePath()
			const oauthStore = yield* makeCodexAuthStore({ path })
			const bedrockStore = yield* makeCodexBedrockAuthStore({ path })
			yield* oauthStore.save(
				new CodexTokenData({ type: 'oauth', access: 'a', refresh: 'r', expires: 123, accountId: 'acct' }),
			)
			const before = yield* readDocument(path)
			yield* bedrockStore.save(
				new CodexBedrockAuthData({
					type: 'aws-profile',
					active: true,
					profile: 'work',
					region: 'us-east-1',
				}),
			)
			const afterSave = yield* readDocument(path)
			expect(afterSave['codex']).toEqual(before['codex'])

			const loaded = yield* bedrockStore.load
			expect(Option.isSome(loaded) && loaded.value.profile).toBe('work')
			yield* bedrockStore.clear
			const afterClear = yield* readDocument(path)
			expect(afterClear['codex_bedrock']).toBeUndefined()
			expect(afterClear['codex']).toEqual(before['codex'])
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	)

	it.effect('invalid entries fail without clobbering the auth document', () =>
		Effect.gen(function* () {
			const path = tempStorePath()
			const contents = JSON.stringify({ codex: { type: 'oauth' }, codex_bedrock: { active: true } })
			writeFileSync(path, contents)
			const store = yield* makeCodexBedrockAuthStore({ path })
			const error = yield* store.load.pipe(Effect.flip)
			expect(error.reason).toBe('InvalidEntry')
			expect(readFileSync(path, 'utf8')).toBe(contents)
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	)

	it.effect('malformed documents cannot be replaced by save', () =>
		Effect.gen(function* () {
			const path = tempStorePath()
			const contents = 'not valid json {'
			writeFileSync(path, contents)
			const store = yield* makeCodexBedrockAuthStore({ path })
			const error = yield* store
				.save(new CodexBedrockAuthData({ type: 'aws-profile', active: true, region: 'us-east-1' }))
				.pipe(Effect.flip)
			expect(error.reason).toBe('InvalidDocument')
			expect(readFileSync(path, 'utf8')).toBe(contents)
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	)

	it.effect('non-not-found read failures propagate and prevent writes', () =>
		Effect.gen(function* () {
			let writes = 0
			const permissionDenied = PlatformError.systemError({
				_tag: 'PermissionDenied',
				module: 'FileSystem',
				method: 'readFileString',
				pathOrDescriptor: '/protected/auth.json',
			})
			const fileSystem = FileSystem.makeNoop({
				readFileString: () => Effect.fail(permissionDenied),
				writeFileString: () => Effect.sync(() => void (writes += 1)),
			})
			const store = yield* makeCodexBedrockAuthStore({ path: '/protected/auth.json' }).pipe(
				Effect.provideService(FileSystem.FileSystem, fileSystem),
			)
			const error = yield* store
				.save(new CodexBedrockAuthData({ type: 'aws-profile', active: true, region: 'us-east-1' }))
				.pipe(Effect.flip)
			expect(error.reason).toBe('ReadFailed')
			expect(writes).toBe(0)
		}),
	)
})
