import type { NewSessionRequest } from './NewSessionModal'
import type { SessionRow } from './SessionListProjection'
import type { TuiOptions } from './TuiSessionOptions'

/** Build a fresh launch request without carrying process-level model, profile, or mode choices across sessions. */
export const requestToLaunchOptions = (options: TuiOptions, request: NewSessionRequest): TuiOptions => {
	const { profile: _profile, modelSelection: _modelSelection, mode: _mode, ...base } = options
	if (request._tag === 'profile') {
		return request.profile === 'default'
			? { ...base, cwd: request.cwd }
			: { ...base, cwd: request.cwd, profile: request.profile }
	}

	const modelSelection =
		request.reasoning === undefined
			? { provider: request.provider, model: request.model }
			: { provider: request.provider, model: request.model, reasoning: request.reasoning }
	return { ...base, cwd: request.cwd, modelSelection, mode: request.mode }
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
	if (model === null) return { ...base, mode }

	const modelSelection =
		model.role === null || model.role === 'inherit'
			? {
					provider: model.providerId,
					model: model.modelId,
					reasoning: model.requestedReasoningLevel,
				}
			: {
					provider: model.providerId,
					model: model.modelId,
					reasoning: model.requestedReasoningLevel,
					role: model.role,
				}
	return { ...base, mode, modelSelection }
}
