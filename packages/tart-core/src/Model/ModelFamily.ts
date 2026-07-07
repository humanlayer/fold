/**
 * This file classifies an ActiveModel into a model family - the coarse grouping that drives per-family
 * system prompt selection (D17), toolset selection (write/edit vs apply_patch, D17/D18), and reasoning
 * parameter mapping (D23). Classification is pure data inspection: provider kind decides first, then
 * model id patterns for openai-compatible endpoints that serve many vendors (openrouter-style ids like
 * "anthropic/claude-...").
 */
import type { ActiveModel } from '../EventLog/Schemas'

/** Coarse model grouping driving per-family prompt, toolset, and reasoning decisions. */
export type ModelFamily = 'claude' | 'codex' | 'gpt' | 'unknown'

/** Classify one resolved model snapshot into its family. */
export const modelFamilyFor = (model: ActiveModel): ModelFamily => {
	switch (model.providerKind) {
		case 'anthropic':
			return 'claude'
		case 'codex':
			return 'codex'
		case 'openai-compatible': {
			const modelId = model.modelId.toLowerCase()
			if (modelId.includes('claude')) return 'claude'
			if (modelId.includes('codex')) return 'codex'
			if (modelId.startsWith('gpt') || /^o\d/.test(modelId)) return 'gpt'
			return 'unknown'
		}
	}
}
