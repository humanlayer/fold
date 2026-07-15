import type { ViewedPatchHashes } from '@humanlayer/fold-agent'

import type { GitChange } from './GitChanges'

export type { ViewedPatchHashes } from '@humanlayer/fold-agent'

export const isChangeViewed = (viewed: ViewedPatchHashes, change: GitChange): boolean =>
	viewed[change.key] === change.patchHash

export const markChangeViewed = (viewed: ViewedPatchHashes, change: GitChange): ViewedPatchHashes => ({
	...viewed,
	[change.key]: change.patchHash,
})
