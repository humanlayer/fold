import { join } from 'node:path'

import { defaultFoldHome } from '@humanlayer/fold-agent'
import type { MakeCodexAuthStoreOptions } from '@humanlayer/fold-codex'

export type ProviderAuthAction = 'status' | 'browser' | 'device' | 'logout'

export type ProviderAuthUpdate =
	| { readonly _tag: 'working'; readonly message: string }
	| { readonly _tag: 'browser'; readonly url: string; readonly opened: boolean }
	| { readonly _tag: 'device'; readonly url: string; readonly code: string }
	| { readonly _tag: 'success'; readonly message: string }
	| { readonly _tag: 'failure'; readonly message: string }

export const codexAuthStoreOptions = (providerId: string, foldHome?: string): MakeCodexAuthStoreOptions => ({
	providerId,
	path: join(foldHome ?? defaultFoldHome(), 'auth.json'),
})

export const providerCredentialLabel = (present: boolean | null): string =>
	present === null ? 'AUTH STATUS AVAILABLE' : present ? 'PRESENT' : 'MISSING'
