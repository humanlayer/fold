import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { layerDefaultSystemPrompt, makeSystemPrompt, SystemPrompt, type ActiveModel } from '../../src/index'

const anthropicModel: ActiveModel = {
	providerId: 'anthropic',
	providerKind: 'anthropic',
	modelId: 'claude-opus-4-8',
	role: null,
	requestedReasoningLevel: 'off',
	thinking: { _tag: 'disabled' },
}

const gptModel: ActiveModel = {
	providerId: 'openai',
	providerKind: 'openai-compatible',
	modelId: 'gpt-5.5',
	role: null,
	requestedReasoningLevel: 'off',
	reasoning: { _tag: 'disabled' },
}

const familyPrompts = makeSystemPrompt({
	basePrompts: { claude: 'CLAUDE BASE PROMPT', codex: 'CODEX BASE PROMPT' },
})

it.effect('prepends the family base prompt for the active model family', () =>
	Effect.gen(function* () {
		const systemPrompt = yield* SystemPrompt
		const blocks = yield* systemPrompt.compose({ model: anthropicModel, agentBlocks: ['agent rules'] })

		expect(blocks).toEqual(['CLAUDE BASE PROMPT', 'agent rules'])
	}).pipe(Effect.provide(familyPrompts)),
)

it.effect('passes agent blocks through when the family has no base prompt', () =>
	Effect.gen(function* () {
		const systemPrompt = yield* SystemPrompt
		const blocks = yield* systemPrompt.compose({ model: gptModel, agentBlocks: ['agent rules'] })

		expect(blocks).toEqual(['agent rules'])
	}).pipe(Effect.provide(familyPrompts)),
)

it.effect('composes the base prompt alone when the agent has no blocks', () =>
	Effect.gen(function* () {
		const systemPrompt = yield* SystemPrompt
		const blocks = yield* systemPrompt.compose({ model: anthropicModel, agentBlocks: [] })

		expect(blocks).toEqual(['CLAUDE BASE PROMPT'])
	}).pipe(Effect.provide(familyPrompts)),
)

it.effect('default layer composes agent blocks unchanged', () =>
	Effect.gen(function* () {
		const systemPrompt = yield* SystemPrompt
		const blocks = yield* systemPrompt.compose({ model: anthropicModel, agentBlocks: ['only block'] })

		expect(blocks).toEqual(['only block'])
	}).pipe(Effect.provide(layerDefaultSystemPrompt)),
)
