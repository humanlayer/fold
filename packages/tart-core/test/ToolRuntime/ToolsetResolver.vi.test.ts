import { expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'

import { makeToolsetResolver, Toolset, ToolsetResolver, type ActiveModel } from '../../src/index'

/** Toolset stub exposing only installed names; the resolver never touches handlers. */
const stubToolset = (names: ReadonlyArray<string>): Layer.Layer<Toolset> =>
	Layer.succeed(Toolset, {
		names: Effect.succeed(names),
		toolkit: Effect.die(new Error('unused in resolver tests')),
		withHandler: Effect.die(new Error('unused in resolver tests')),
		handle: () => Effect.die(new Error('unused in resolver tests')),
	})

const installed = ['echo', 'read', 'write', 'edit', 'apply_patch', 'bash']

const codexModel: ActiveModel = {
	providerId: 'codex',
	providerKind: 'codex',
	modelId: 'gpt-5.5',
	role: null,
	requestedReasoningLevel: 'medium',
	reasoning: { _tag: 'effort', effort: 'medium', summary: 'auto' },
}

const gptModel: ActiveModel = {
	providerId: 'openai',
	providerKind: 'openai-compatible',
	modelId: 'gpt-5.5',
	role: null,
	requestedReasoningLevel: 'medium',
	reasoning: { _tag: 'effort', effort: 'medium' },
}

const claudeModel: ActiveModel = {
	providerId: 'anthropic',
	providerKind: 'anthropic',
	modelId: 'claude-opus-4-8',
	role: null,
	requestedReasoningLevel: 'off',
	thinking: { _tag: 'disabled' },
}

const unknownModel: ActiveModel = {
	providerId: 'local',
	providerKind: 'openai-compatible',
	modelId: 'llama-3.3-70b',
	role: null,
	requestedReasoningLevel: 'off',
	reasoning: { _tag: 'disabled' },
}

const resolveFor = (model: ActiveModel, layer: Layer.Layer<ToolsetResolver>) =>
	Effect.gen(function* () {
		const resolver = yield* ToolsetResolver

		return yield* resolver.resolve({ model })
	}).pipe(Effect.provide(layer))

it.effect('codex-family models edit through apply_patch: write and edit are hidden', () =>
	Effect.gen(function* () {
		const layer = makeToolsetResolver().pipe(Layer.provide(stubToolset(installed)))
		const resolved = yield* resolveFor(codexModel, layer)

		expect(resolved.names).toEqual(['echo', 'read', 'apply_patch', 'bash'])
	}),
)

it.effect('claude-family models edit through write/edit: apply_patch is hidden', () =>
	Effect.gen(function* () {
		const layer = makeToolsetResolver().pipe(Layer.provide(stubToolset(installed)))
		const resolved = yield* resolveFor(claudeModel, layer)

		expect(resolved.names).toEqual(['echo', 'read', 'write', 'edit', 'bash'])
	}),
)

it.effect('gpt-family models edit through apply_patch: write and edit are hidden', () =>
	Effect.gen(function* () {
		const layer = makeToolsetResolver().pipe(Layer.provide(stubToolset(installed)))
		const resolved = yield* resolveFor(gptModel, layer)

		expect(resolved.names).toEqual(['echo', 'read', 'apply_patch', 'bash'])
	}),
)

it.effect('unknown families default to write/edit editing', () =>
	Effect.gen(function* () {
		const layer = makeToolsetResolver().pipe(Layer.provide(stubToolset(installed)))
		const resolved = yield* resolveFor(unknownModel, layer)

		expect(resolved.names).toEqual(['echo', 'read', 'write', 'edit', 'bash'])
	}),
)

it.effect('policy overrides merge over the default family exclusions', () =>
	Effect.gen(function* () {
		const layer = makeToolsetResolver({ excludedToolsByFamily: { claude: ['bash', 'apply_patch'] } }).pipe(
			Layer.provide(stubToolset(installed)),
		)
		const resolved = yield* resolveFor(claudeModel, layer)

		expect(resolved.names).toEqual(['echo', 'read', 'write', 'edit'])
	}),
)
