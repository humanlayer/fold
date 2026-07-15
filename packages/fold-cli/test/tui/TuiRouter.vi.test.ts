import { SessionId } from '@humanlayer/fold-core'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeTuiRouter } from '../../src/tui/TuiRouter'

const sessionId = (suffix: string) => Schema.decodeUnknownSync(SessionId)(`sess_${suffix.padEnd(24, 'x')}`)

describe('TuiRouter', () => {
	it('performs synchronous picker and session transitions', () => {
		const router = makeTuiRouter({ _tag: 'picker' })
		const activation = router.beginSessionActivation()

		expect(router.route()).toEqual({ _tag: 'picker' })
		const selected = sessionId('one')
		expect(router.showSession(activation, selected)).toBe(true)
		expect(router.route()).toEqual({ _tag: 'session', sessionId: selected })

		router.showPicker()
		expect(router.route()).toEqual({ _tag: 'picker' })
	})

	it('rejects stale activation after newer navigation', () => {
		const router = makeTuiRouter({ _tag: 'picker' })
		const stale = router.beginSessionActivation()
		const current = router.beginSessionActivation()

		const currentId = sessionId('current')
		expect(router.showSession(current, currentId)).toBe(true)
		expect(router.showSession(stale, sessionId('stale'))).toBe(false)
		expect(router.route()).toEqual({ _tag: 'session', sessionId: currentId })

		const pending = router.beginSessionActivation()
		router.showPicker()
		expect(router.showSession(pending, sessionId('late'))).toBe(false)
		expect(router.route()).toEqual({ _tag: 'picker' })
	})

	it('returns from providers to the exact originating route', () => {
		const router = makeTuiRouter({ _tag: 'picker' })
		const pending = router.beginSessionActivation()
		router.showProviders()
		expect(router.route()).toEqual({ _tag: 'providers', returnTo: { _tag: 'picker' } })
		expect(router.showSession(pending, sessionId('late'))).toBe(false)
		expect(router.backFromProviders()).toBe(true)
		expect(router.route()).toEqual({ _tag: 'picker' })

		const selected = sessionId('origin')
		const activation = router.beginSessionActivation()
		router.showSession(activation, selected)
		router.showProviders()
		expect(router.route()).toEqual({
			_tag: 'providers',
			returnTo: { _tag: 'session', sessionId: selected },
		})
		router.showProviders()
		expect(router.backFromProviders()).toBe(true)
		expect(router.route()).toEqual({ _tag: 'session', sessionId: selected })
		expect(router.backFromProviders()).toBe(false)
	})
})
