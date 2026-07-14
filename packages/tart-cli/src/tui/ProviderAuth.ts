import { join } from 'node:path'

import { defaultTartHome } from '@humanlayer/tart-agent'
import type { MakeCodexAuthStoreOptions } from '@humanlayer/tart-codex'

export type ProviderAuthAction = 'status' | 'browser' | 'device' | 'logout'

export type ProviderAuthUpdate =
	| { readonly _tag: 'working'; readonly message: string }
	| { readonly _tag: 'browser'; readonly url: string; readonly opened: boolean }
	| { readonly _tag: 'device'; readonly url: string; readonly code: string }
	| { readonly _tag: 'success'; readonly message: string }
	| { readonly _tag: 'failure'; readonly message: string }

export const codexAuthStoreOptions = (providerId: string, tartHome?: string): MakeCodexAuthStoreOptions => ({
	providerId,
	path: join(tartHome ?? defaultTartHome(), 'auth.json'),
})

export const providerCredentialLabel = (present: boolean | null): string =>
	present === null ? 'AUTH STATUS AVAILABLE' : present ? 'PRESENT' : 'MISSING'
