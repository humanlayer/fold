/**
 * This file implements the default ToolsetResolver layer - family-exclusion policy over the installed
 * Toolset (D17/D18, user ruling 2026-07-06): claude-family models edit through write/edit
 * (apply_patch hidden); gpt- and codex-family models edit through apply_patch (write/edit hidden);
 * unknown families default to write/edit. Tools not named by the policy (echo, bash, read, subagent,
 * skill, ...) are family-neutral and always included.
 */
import { Effect, Layer } from 'effect'

import { modelFamilyFor, type ModelFamily } from '../Model/ModelFamily'
import { ToolsetResolver, type ResolveToolsetInput } from './ToolsetResolverService'
import { Toolset } from './ToolsetService'

/** Default family-exclusion policy: which installed tool names are hidden from each family (D17/D18). */
export const defaultExcludedToolsByFamily: Record<ModelFamily, ReadonlyArray<string>> = {
	claude: ['apply_patch'],
	unknown: ['apply_patch'],
	gpt: ['write', 'edit'],
	codex: ['write', 'edit'],
}

/** Options for the default ToolsetResolver implementation. */
export type MakeToolsetResolverOptions = {
	/** Per-family exclusion overrides, merged over the default policy. */
	readonly excludedToolsByFamily?: Partial<Record<ModelFamily, ReadonlyArray<string>>>
}

/** Build a ToolsetResolver layer filtering the installed Toolset by family-exclusion policy. */
export const makeToolsetResolver = (
	options?: MakeToolsetResolverOptions,
): Layer.Layer<ToolsetResolver, never, Toolset> =>
	Layer.effect(
		ToolsetResolver,
		Effect.gen(function* () {
			const toolset = yield* Toolset
			const excludedByFamily = { ...defaultExcludedToolsByFamily, ...options?.excludedToolsByFamily }

			return {
				resolve: Effect.fn('fold.toolset_resolver.resolve')((input: ResolveToolsetInput) =>
					Effect.gen(function* () {
						const names = yield* toolset.names
						const excluded = excludedByFamily[modelFamilyFor(input.model)]

						return { names: names.filter((name) => !excluded.includes(name)) }
					}),
				),
			}
		}),
	)

/** Default ToolsetResolver layer with the standard family-exclusion policy. */
export const liveToolsetResolverLayer: Layer.Layer<ToolsetResolver, never, Toolset> = makeToolsetResolver()
