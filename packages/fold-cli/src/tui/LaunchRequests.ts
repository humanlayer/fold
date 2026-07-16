import type { NewSessionRequest } from './NewSessionModal'
import type { SessionRow } from './SessionListProjection'
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

/** Resume with the durable session's model intent instead of the process's current model selection. */
export const sessionToLaunchOptions = (
	options: TuiOptions,
	session: Pick<SessionRow, 'model' | 'mode' | 'profile'>,
): TuiOptions => {
	const { profile: _profile, modelSelection: _modelSelection, mode: _mode, ...base } = options
	const mode = session.mode === 'rlm' ? 'rlm' : 'default'
	if (session.profile !== null && session.profile !== 'default') return { ...base, profile: session.profile, mode }
	const model = session.model
	return {
		...base,
		mode,
		...(model === null
			? {}
			: {
					modelSelection: {
						provider: model.providerId,
						model: model.modelId,
						reasoning: model.requestedReasoningLevel,
						...(model.role === null || model.role === 'inherit' ? {} : { role: model.role }),
					},
				}),
	}
}
