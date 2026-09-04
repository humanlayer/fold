import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { CodexTokenData, makeCodexLanguageModel } from '../src/index'
import type { CodexAuthStore } from '../src/index'
import { type CapturedFetchRequest, makeCapturingFetch, runImageReadInference } from './SessionModelPathTestHarness'

const terminalSse = `data: ${JSON.stringify({
	type: 'response.completed',
	response: { id: 'resp_alternate_store', model: 'gpt-5.5', created_at: 1, output: [] },
	sequence_number: 1,
})}\n\n`

it.effect('OAuth store overrides resolve codex_bedrock from the same auth document', () => {
	const root = mkdtempSync(join(tmpdir(), 'fold-codex-alternate-store-'))
	const authPath = join(root, 'alternate-auth.json')
	const codexHome = join(root, 'codex')
	mkdirSync(codexHome)
	writeFileSync(authPath, JSON.stringify({ codex_bedrock: { type: 'aws-profile', active: false } }))
	writeFileSync(
		join(codexHome, 'config.toml'),
		'model_provider = "amazon-bedrock"\n[model_providers.amazon-bedrock.aws]\nregion = "us-east-1"\n',
	)

	const token = new CodexTokenData({
		type: 'oauth',
		access: 'alternate-access-token',
		refresh: 'unused-refresh-token',
		expires: Number.MAX_SAFE_INTEGER,
	})
	const alternateStore: CodexAuthStore = {
		path: authPath,
		load: Effect.succeed(Option.some(token)),
		save: (updated) => Effect.succeed(updated),
		clear: Effect.void,
	}
	const requests: Array<CapturedFetchRequest> = []
	const capturingFetch = makeCapturingFetch(
		requests,
		() => new Response(terminalSse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
	)

	return Effect.gen(function* () {
		const model = yield* makeCodexLanguageModel({
			model: 'gpt-5.5',
			apiUrl: 'https://chatgpt.alternate.test/backend-api/codex',
			store: alternateStore,
			codexHome,
			requestRetryTimes: 0,
		})
		yield* runImageReadInference(model)
		expect(requests).toHaveLength(1)
		expect(requests[0]?.url).toBe('https://chatgpt.alternate.test/backend-api/codex/responses')
		expect(requests[0]?.authorization).toBe('Bearer alternate-access-token')
	}).pipe(Effect.provideService(FetchHttpClient.Fetch, capturingFetch))
})
