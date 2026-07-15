import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { resolveCodexLoginFlow, shouldOpenBrowserForCodexLogin } from '../src/index'

it.effect('selects browser login for interactive auto mode', () =>
	Effect.sync(() => {
		expect(
			resolveCodexLoginFlow({
				flow: 'auto',
				device: false,
				browser: false,
				stdinIsTTY: true,
				stdoutIsTTY: true,
				isCi: false,
			}),
		).toBe('browser')
	}),
)

it.effect('selects device login for CI/headless auto mode', () =>
	Effect.sync(() => {
		expect(
			resolveCodexLoginFlow({
				flow: undefined,
				device: false,
				browser: false,
				stdinIsTTY: true,
				stdoutIsTTY: true,
				isCi: true,
			}),
		).toBe('device')
		expect(
			resolveCodexLoginFlow({
				flow: undefined,
				device: false,
				browser: false,
				stdinIsTTY: false,
				stdoutIsTTY: true,
				isCi: false,
			}),
		).toBe('device')
	}),
)

it.effect('lets explicit flow override legacy flags', () =>
	Effect.sync(() => {
		expect(
			resolveCodexLoginFlow({
				flow: 'device',
				device: false,
				browser: true,
				stdinIsTTY: true,
				stdoutIsTTY: true,
				isCi: false,
			}),
		).toBe('device')
	}),
)

it.effect('only auto-opens the browser for browser flow on a TTY without --no-open', () =>
	Effect.sync(() => {
		expect(shouldOpenBrowserForCodexLogin({ flow: 'browser', noOpen: false, stdoutIsTTY: true })).toBe(true)
		expect(shouldOpenBrowserForCodexLogin({ flow: 'browser', noOpen: true, stdoutIsTTY: true })).toBe(false)
		expect(shouldOpenBrowserForCodexLogin({ flow: 'browser', noOpen: false, stdoutIsTTY: false })).toBe(false)
		expect(shouldOpenBrowserForCodexLogin({ flow: 'device', noOpen: false, stdoutIsTTY: true })).toBe(false)
	}),
)
