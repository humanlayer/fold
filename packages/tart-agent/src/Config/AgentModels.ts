/**
 * This file resolves a config role to a runnable `TartModel` (D25's `AgentModels`). A role binding
 * (provider + model + reasoning) plus its provider connection produce a model descriptor: `anthropic`
 * and `openai-compat` build the tart-core descriptors with a `Redacted` key (resolved from `apiKeyEnv`
 * or inline `apiKey` at this provider edge, never earlier); `codex` builds the tart-codex descriptor,
 * which carries no key (it uses `~/.tart/auth.json`).
 *
 * `orchestrator` falls back to `smart` when unbound (D25). Provider cross-references were validated at
 * decode (ConfigSchema), so the only resolution failure is a genuinely runtime one - a missing
 * credential env var - surfaced as a typed `RoleResolutionError`. The resolved model records the
 * requested role on its `ActiveModel` snapshot for log/cost provenance.
 */
import { codexModel } from '@humanlayer/tart-codex'
import { anthropicModel, openaiModel } from '@humanlayer/tart-core'
import type { ActiveModel, ReasoningLevel, TartModel } from '@humanlayer/tart-core'
import { Effect, Redacted, Schema } from 'effect'

import { ConfigRole, type ProviderConnection, type RoleBinding, type TartConfig } from './ConfigSchema'

/** A role could not be resolved to a runnable model (missing credential env var). */
export class RoleResolutionError extends Schema.TaggedErrorClass<RoleResolutionError>()('RoleResolutionError', {
	role: ConfigRole,
	message: Schema.String,
}) {}

/** Environment variable lookup seam. Defaults to `process.env`; overridable for hermetic tests. */
export type EnvLookup = (name: string) => string | undefined

/** Options for {@link agentModelsFromConfig}. */
export type AgentModelsOptions = {
	/** Environment lookup for `apiKeyEnv`. Defaults to reading `process.env`. */
	readonly env?: EnvLookup
}

/** Resolves config roles to runnable model descriptors (D25). */
export type AgentModels = {
	readonly resolve: (role: ConfigRole) => Effect.Effect<TartModel, RoleResolutionError>
}

const defaultEnv: EnvLookup = (name) => process.env[name]

/** Stamp the requested role onto the resolved model's snapshot (provenance in the durable log). */
const withRole = (model: TartModel, role: ConfigRole): TartModel => {
	const activeModel: ActiveModel = { ...model.activeModel, role }
	return { ...model, activeModel }
}

/** Build the resolver over a decoded config. */
export const agentModelsFromConfig = (config: TartConfig, options?: AgentModelsOptions): AgentModels => {
	const env = options?.env ?? defaultEnv

	/** The binding for a role; `orchestrator` falls back to `smart`. */
	const bindingFor = (role: ConfigRole): RoleBinding =>
		role === 'fast'
			? config.roles.fast
			: role === 'orchestrator'
				? (config.roles.orchestrator ?? config.roles.smart)
				: config.roles.smart

	/** Resolve the API key for a keyed provider (anthropic/openai-compat). */
	const resolveApiKey = (
		role: ConfigRole,
		providerName: string,
		provider: ProviderConnection,
	): Effect.Effect<string, RoleResolutionError> => {
		if (provider.apiKeyEnv !== undefined) {
			const value = env(provider.apiKeyEnv)
			return value === undefined || value === ''
				? Effect.fail(
						new RoleResolutionError({
							role,
							message: `provider "${providerName}" reads its API key from $${provider.apiKeyEnv}, which is not set`,
						}),
					)
				: Effect.succeed(value)
		}
		if (provider.apiKey !== undefined) return Effect.succeed(provider.apiKey)

		return Effect.fail(
			new RoleResolutionError({
				role,
				message: `provider "${providerName}" (kind ${provider.kind}) needs an apiKeyEnv or apiKey`,
			}),
		)
	}

	const resolve = (role: ConfigRole): Effect.Effect<TartModel, RoleResolutionError> =>
		Effect.gen(function* () {
			const binding = bindingFor(role)
			const providerName = binding.provider
			const provider = config.providers[providerName]
			// Cross-referenced at decode, but guard so a hand-built config can't produce an unclear crash.
			if (provider === undefined) {
				return yield* new RoleResolutionError({
					role,
					message: `role "${role}" references undeclared provider "${providerName}"`,
				})
			}

			const reasoning: ReasoningLevel | undefined = binding.reasoning
			const reasoningOption = reasoning === undefined ? {} : { reasoning }
			const baseUrlOption = provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }

			if (provider.kind === 'codex') {
				const apiUrlOption = provider.baseUrl === undefined ? {} : { apiUrl: provider.baseUrl }
				return withRole(
					codexModel({ model: binding.model, providerId: providerName, ...reasoningOption, ...apiUrlOption }),
					role,
				)
			}

			const apiKey = yield* resolveApiKey(role, providerName, provider)
			const modelOptions = {
				model: binding.model,
				apiKey: Redacted.make(apiKey),
				providerId: providerName,
				...reasoningOption,
				...baseUrlOption,
			}

			return withRole(
				provider.kind === 'anthropic' ? anthropicModel(modelOptions) : openaiModel(modelOptions),
				role,
			)
		})

	return { resolve }
}
