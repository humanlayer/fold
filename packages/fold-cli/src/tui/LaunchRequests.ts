import type { NewSessionRequest } from './NewSessionModal'
import type { SessionRow } from './SessionListProjection'
import type { TuiOptions } from './TuiSessionOptions'

type Mutable<Type> = { -readonly [Key in keyof Type]: Type[Key] }

/** Build a fresh launch request without carrying process-level model, profile, or mode choices across sessions. */
export const requestToLaunchOptions = (options: TuiOptions, request: NewSessionRequest): TuiOptions => {
	const { profile: _profile, modelSelection: _modelSelection, mode: _mode, ...base } = options
	const launch: Mutable<TuiOptions> = { ...base, cwd: request.cwd }
	if (request._tag === 'profile') {
		if (request.profile !== 'default') launch.profile = request.profile
		return launch
	}

	const modelSelection: Mutable<NonNullable<TuiOptions['modelSelection']>> = {
		provider: request.provider,
		model: request.model,
	}
	if (request.reasoning !== undefined) modelSelection.reasoning = request.reasoning
	launch.modelSelection = modelSelection
	launch.mode = request.mode
	return launch
}

/** Resume with the durable session's model intent instead of the process's current model selection. */
export const sessionToLaunchOptions = (
	options: TuiOptions,
	session: Pick<SessionRow, 'model' | 'mode' | 'profile'>,
): TuiOptions => {
	const { profile: _profile, modelSelection: _modelSelection, mode: _mode, ...base } = options
	const mode = session.mode === 'rlm' ? 'rlm' : 'default'
	const launch: Mutable<TuiOptions> = { ...base, mode }
	if (session.profile !== null && session.profile !== 'default') {
		launch.profile = session.profile
		return launch
	}
	const model = session.model
	if (model === null) return launch

	const modelSelection: Mutable<NonNullable<TuiOptions['modelSelection']>> = {
		provider: model.providerId,
		model: model.modelId,
		reasoning: model.requestedReasoningLevel,
	}
	if (model.role !== null && model.role !== 'inherit') modelSelection.role = model.role
	launch.modelSelection = modelSelection
	return launch
}
