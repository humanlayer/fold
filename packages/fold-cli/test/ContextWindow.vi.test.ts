import type { ActiveModel } from '@humanlayer/fold-core'
import { expect, it } from 'vitest'

import { contextUsedPercentForDisplay, contextWindowLimitForDisplay } from '../src/ContextWindow'

const astra: ActiveModel = {
	providerId: 'codex',
	providerKind: 'codex' as const,
	modelId: 'gpt-6-astra',
	role: null,
	requestedReasoningLevel: 'max' as const,
	reasoning: { _tag: 'effort', effort: 'max', summary: 'auto' },
}

it('shows the Codex usable Astra window instead of the public API catalog window', () => {
	expect(contextWindowLimitForDisplay(astra, 1_050_000)).toBe(258_400)
})

it('matches the Codex gauge percentage after excluding its baseline tokens', () => {
	const limit = contextWindowLimitForDisplay(astra, 1_050_000)

	expect(contextUsedPercentForDisplay(12_000, astra, limit)).toBe(0)
	expect(contextUsedPercentForDisplay(240_000, astra, limit)).toBe(93)
})
