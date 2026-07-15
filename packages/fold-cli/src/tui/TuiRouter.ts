import type { SessionId } from '@humanlayer/fold-core'
import { createSignal, type Accessor } from 'solid-js'

export type TuiBaseRoute = { readonly _tag: 'picker' } | { readonly _tag: 'session'; readonly sessionId: SessionId }
export type TuiRoute = TuiBaseRoute | { readonly _tag: 'providers'; readonly returnTo: TuiBaseRoute }

export type SessionActivation = { readonly generation: number }

export type TuiRouter = {
	readonly route: Accessor<TuiRoute>
	readonly beginSessionActivation: () => SessionActivation
	readonly showSession: (activation: SessionActivation, sessionId: SessionId) => boolean
	readonly showPicker: () => void
	readonly showProviders: () => void
	readonly backFromProviders: () => boolean
}

export const makeTuiRouter = (initialRoute: TuiRoute): TuiRouter => {
	const [route, setRoute] = createSignal<TuiRoute>(initialRoute)
	let generation = 0

	return {
		route,
		beginSessionActivation: () => ({ generation: ++generation }),
		showSession: (activation, sessionId) => {
			if (activation.generation !== generation) return false
			setRoute({ _tag: 'session', sessionId })
			return true
		},
		showPicker: () => {
			generation++
			setRoute({ _tag: 'picker' })
		},
		showProviders: () => {
			const current = route()
			if (current._tag !== 'providers') {
				generation++
				setRoute({ _tag: 'providers', returnTo: current })
			}
		},
		backFromProviders: () => {
			const current = route()
			if (current._tag !== 'providers') return false
			setRoute(current.returnTo)
			return true
		},
	}
}
