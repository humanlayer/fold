import { expect, it } from '@effect/vitest'
import { describeModelConfiguration } from '@humanlayer/fold-agent'
import { Effect } from 'effect'

import { memoryFileFor, memoryFileSystem } from '../../../fold-agent/test/TestHelpers'
import { providerManagementRows } from '../../src/tui/ProviderConfigState'
import { bootstrapTuiConfig } from '../../src/tui/TuiConfigBootstrap'

const requireConfig = <A>(config: A | null): A => {
	if (config === null) throw new Error('expected bootstrapped config')
	return config
}

it.effect('bootstraps and loads a fresh fold home before deriving provider management rows', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({})
		const result = yield* bootstrapTuiConfig({ foldHome: '/fresh/.fold', fileSystem: fs })

		expect(result.notice).toBeNull()
		expect(result.config).not.toBeNull()
		expect(yield* memoryFileFor(fs, '/fresh/.fold/auth.json')).toBe('{}\n')
		const rows = providerManagementRows(
			describeModelConfiguration(requireConfig(result.config), [], () => undefined),
		)
		expect(rows.map(({ label }) => label)).toEqual([
			'OpenAI',
			'Anthropic',
			'Codex',
			'Grok',
			'OpenCode Zen / Black',
			'+ Add OpenAI-compatible',
			'+ Add Anthropic-compatible',
		])
		expect(rows.every(({ type }) => type === 'configured' || type === 'create')).toBe(true)
	}),
)

it.effect('does not rewrite an old commented config while virtual provider rows fill its gaps', () =>
	Effect.gen(function* () {
		const oldConfig = `{
			// Keep this user comment exactly.
			"providers": { "openai": { "kind": "openai-compat", "apiKeyEnv": "OPENAI_API_KEY" } },
			"roles": { "smart": { "provider": "openai", "model": "gpt-old" }, "fast": { "provider": "openai", "model": "gpt-old" } }
		}\n`
		const fs = memoryFileSystem({ '/old/.fold/config.jsonc': oldConfig })
		const result = yield* bootstrapTuiConfig({ foldHome: '/old/.fold', fileSystem: fs })

		expect(result.notice).toBeNull()
		expect(yield* memoryFileFor(fs, '/old/.fold/config.jsonc')).toBe(oldConfig)
		const rows = providerManagementRows(
			describeModelConfiguration(requireConfig(result.config), [], () => undefined),
		)
		expect(rows.slice(0, 7).map(({ label }) => label)).toEqual([
			'OpenAI',
			'Anthropic',
			'Codex',
			'Grok',
			'OpenCode Zen / Black',
			'+ Add OpenAI-compatible',
			'+ Add Anthropic-compatible',
		])
	}),
)

it.effect('surfaces bootstrap failure while canonical virtual rows remain available', () =>
	Effect.gen(function* () {
		const base = memoryFileSystem({})
		const fs = { ...base, writeFileString: () => Effect.die(new Error('fixture write failure')) }
		const result = yield* bootstrapTuiConfig({ foldHome: '/blocked', fileSystem: fs })

		expect(result.config).toBeNull()
		expect(result.notice).toContain('CONFIGURATION BOOTSTRAP ERROR')
		expect(providerManagementRows({ profiles: [], providers: [] }).map(({ label }) => label)).toHaveLength(7)
	}),
)
