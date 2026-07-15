import { describe, expect, it } from 'vitest'

import {
	codexAuthStoreOptions,
	oauthProviderLabel,
	openCodeAuthStoreOptions,
	providerAuthActions,
	providerCredentialLabel,
	xaiAuthStoreOptions,
} from '../../src/tui/ProviderAuth'

describe('provider auth configuration', () => {
	it('maps the configured provider name and fold home to the shared auth store', () => {
		expect(codexAuthStoreOptions('work-codex', '/tmp/fold-home')).toEqual({
			providerId: 'work-codex',
			path: '/tmp/fold-home/auth.json',
		})
	})

	it('labels OAuth kinds and exposes only their supported actions', () => {
		expect(oauthProviderLabel('opencode')).toBe('OpenCode OAuth')
		expect(oauthProviderLabel('xai')).toBe('xAI OAuth')
		expect(providerAuthActions('opencode')).toEqual(['status', 'device', 'logout'])
		expect(providerAuthActions('codex')).toContain('browser')
		expect(providerAuthActions('xai')).toContain('browser')
	})

	it('maps OpenCode and xAI aliases to the shared auth document', () => {
		expect(openCodeAuthStoreOptions('zen', '/tmp/fold-home')).toEqual({
			providerId: 'zen',
			path: '/tmp/fold-home/auth.json',
		})
		expect(xaiAuthStoreOptions('grok', '/tmp/fold-home')).toEqual({
			providerId: 'grok',
			path: '/tmp/fold-home/auth.json',
		})
	})

	it('produces secret-free credential view labels', () => {
		expect(providerCredentialLabel(true)).toBe('PRESENT')
		expect(providerCredentialLabel(false)).toBe('MISSING')
		expect(providerCredentialLabel(null)).toBe('NOT CHECKED')
	})
})
