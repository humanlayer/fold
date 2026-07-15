/**
 * Live integration against the real ChatGPT Codex backend using the credentials in ~/.fold/auth.json.
 * Skipped when CI is set or no codex credential exists, so the suite stays green everywhere else.
 * These tests exercise the full stack: auth store -> token refresh (when expired) -> authed OpenAI
 * client -> instructions transform -> hardened stream.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Schema, Stream } from 'effect'

import { makeCodexLanguageModel } from '../src/index'

const authPath = join(homedir(), '.fold', 'auth.json')

const decodeCredentialProbe = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Struct({ codex: Schema.optionalKey(Schema.Struct({ type: Schema.String })) })),
)

const hasCodexCredentials = (): boolean => {
	try {
		if (!existsSync(authPath)) return false
		const document = decodeCredentialProbe(readFileSync(authPath, 'utf8'))
		return Option.isSome(document) && document.value.codex?.type === 'oauth'
	} catch {
		return false
	}
}

const skip = Boolean(process.env.CI) || !hasCodexCredentials()
const modelId = process.env.FOLD_CODEX_LIVE_MODEL ?? 'gpt-5.5'

describe.skipIf(skip)('codex live (skipped in CI or without a codex entry in ~/.fold/auth.json)', () => {
	it.live(
		'generateText round-trips against the codex backend',
		() =>
			Effect.gen(function* () {
				const service = yield* makeCodexLanguageModel({ model: modelId, reasoning: 'low' })

				const response = yield* service.generateText({
					prompt: [
						{ role: 'system', content: 'Answer with a single lowercase word and nothing else.' },
						{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly the word: pong' }] },
					],
				})

				expect(response.text.toLowerCase()).toContain('pong')
				expect(response.finishReason).toBe('stop')
			}).pipe(Effect.scoped),
		180_000,
	)

	it.live(
		'streamText streams text deltas and a finish part',
		() =>
			Effect.gen(function* () {
				const service = yield* makeCodexLanguageModel({ model: modelId, reasoning: 'low' })

				const parts = yield* Stream.runCollect(
					service.streamText({
						prompt: [
							{ role: 'system', content: 'Answer with a single lowercase word and nothing else.' },
							{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly the word: ping' }] },
						],
					}),
				)

				let text = ''
				for (const part of parts) {
					if (part.type === 'text-delta') text += part.delta
				}

				expect(text.toLowerCase()).toContain('ping')
				expect(parts.some((part) => part.type === 'finish')).toBe(true)
			}).pipe(Effect.scoped),
		180_000,
	)
})
