import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assert, it } from '@effect/vitest'
import {
	OpenAiClient,
	OpenAiConfig,
	OpenAiEmbeddingModel,
	OpenAiLanguageModel,
} from '@humanlayer/effect-ai-openai-compat'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

it('keeps unmodified OpenAI-compatible provider source snapshot files byte-exact', () => {
	const checksums = readFileSync(join(packageRoot, 'UPSTREAM.sha256'), 'utf8')
		.trim()
		.split('\n')
		.map((line) => {
			const separator = line.indexOf('  ')
			return { checksum: line.slice(0, separator), path: line.slice(separator + 2) }
		})

	for (const { checksum, path } of checksums) {
		const contents = readFileSync(join(packageRoot, path))
		const actual = createHash('sha256').update(contents).digest('hex')
		assert.strictEqual(actual, checksum, path)
	}
})

it('uses HumanLayer-specific Effect service keys', () => {
	assert.strictEqual(OpenAiClient.OpenAiClient.key, '@humanlayer/effect-ai-openai-compat/OpenAiClient')
	assert.strictEqual(OpenAiConfig.OpenAiConfig.key, '@humanlayer/effect-ai-openai-compat/OpenAiConfig')
	assert.strictEqual(
		OpenAiEmbeddingModel.Config.key,
		'@humanlayer/effect-ai-openai-compat/OpenAiEmbeddingModel/Config',
	)
	assert.strictEqual(OpenAiLanguageModel.Config.key, '@humanlayer/effect-ai-openai-compat/OpenAiLanguageModel/Config')
})
