import type { NewSessionRequest } from './NewSessionModal'
import type { TuiOptions } from './TuiSessionOptions'

/** Build a fresh launch request without carrying process-level model, profile, or mode choices across sessions. */
export const requestToLaunchOptions = (options: TuiOptions, request: NewSessionRequest): TuiOptions => {
	const { profile: _profile, modelSelection: _modelSelection, mode: _mode, ...base } = options
	return {
		...base,
		cwd: request.cwd,
		...(request._tag === 'profile'
			? request.profile === 'default'
				? {}
				: { profile: request.profile }
			: { modelSelection: { provider: request.provider, model: request.model }, mode: request.mode }),
	}
}
