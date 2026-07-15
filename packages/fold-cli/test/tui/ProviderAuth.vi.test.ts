import { describe, expect, it } from 'vitest'

import { codexAuthStoreOptions, providerCredentialLabel } from '../../src/tui/ProviderAuth'

describe('provider auth configuration', () => {
	it('maps the configured provider name and fold home to the shared auth store', () => {
		expect(codexAuthStoreOptions('work-codex', '/tmp/fold-home')).toEqual({
			providerId: 'work-codex',
			path: '/tmp/fold-home/auth.json',
		})
	})

	it('produces secret-free credential view labels', () => {
		expect(providerCredentialLabel(true)).toBe('PRESENT')
		expect(providerCredentialLabel(false)).toBe('MISSING')
		expect(providerCredentialLabel(null)).toBe('AUTH STATUS AVAILABLE')
	})
})
