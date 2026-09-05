import { defaultContextWindowFor, type ActiveModel } from '@humanlayer/fold-core'

const CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95
const CODEX_BASELINE_TOKENS = 12_000

export const contextWindowLimitForDisplay = (model: ActiveModel, catalogContextWindow?: number): number => {
	const rawLimit =
		model.providerKind === 'codex'
			? defaultContextWindowFor(model.modelId)
			: (catalogContextWindow ?? defaultContextWindowFor(model.modelId))

	return model.providerKind === 'codex'
		? Math.floor((rawLimit * CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT) / 100)
		: rawLimit
}

export const contextUsedPercentForDisplay = (used: number, model: ActiveModel, limit: number): number => {
	if (model.providerKind !== 'codex') return Math.min(100, Math.round((used / limit) * 100))
	if (limit <= CODEX_BASELINE_TOKENS) return 100

	const effectiveWindow = limit - CODEX_BASELINE_TOKENS
	const effectiveUsed = Math.max(0, used - CODEX_BASELINE_TOKENS)
	const remaining = Math.max(0, effectiveWindow - effectiveUsed)
	const remainingPercent = Math.round((remaining / effectiveWindow) * 100)

	return 100 - remainingPercent
}
