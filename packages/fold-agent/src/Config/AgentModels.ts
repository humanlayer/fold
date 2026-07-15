/**
 * This file resolves a config role to a runnable `FoldModel` (D25's `AgentModels`). A role binding
 * (provider + model + reasoning) plus its provider connection produce a model descriptor: `anthropic`
 * and `openai-compat` build the fold-core descriptors with a `Redacted` key (resolved from `apiKeyEnv`
 * or inline `apiKey` at this provider edge, never earlier); `codex` builds the fold-codex descriptor,
 * which carries no key (it uses `~/.fold/auth.json`).
 *
 * `orchestrator` falls back to `smart` when unbound (D25). A binding without a model fills the provider
 * kind's default (codex → gpt-5.6-sol, anthropic → claude-opus-4-8); openai-compat has no default and
 * requires an explicit model. Provider cross-references were validated at decode (ConfigSchema), so
 * remaining resolution failures are a missing credential env var, a model-less openai-compat binding,
 * or - when a model catalog is provided - a reasoning level the bound model does not support (D23:
 * per-model reasoning support is data, not code). All surface as a typed `RoleResolutionError`. The
 * resolved model records the requested role on its `ActiveModel` snapshot for log/cost provenance.
 */
import { codexModel, DEFAULT_CODEX_MODEL_ID } from '@humanlayer/fold-codex'
import { anthropicModel, DEFAULT_ANTHROPIC_MODEL_ID, lookupCatalogEntry, openaiModel } from '@humanlayer/fold-core'
import type { ActiveModel, ModelCatalogEntry, ReasoningLevel, FoldModel } from '@humanlayer/fold-core'
import { Effect, Redacted, Schema } from 'effect'

import { ConfigRole, type ProviderConnection, type RoleBinding, type FoldConfig } from './ConfigSchema'

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
	/**
	 * Model catalog entries for reasoning-support validation (D23). When the bound model has a catalog
	 * entry, a configured reasoning level it does not support fails resolution; models the catalog does
	 * not know pass through permissively. Omitted means no validation.
	 */
	readonly catalog?: ReadonlyArray<ModelCatalogEntry>
}

/** Resolves config roles to runnable model descriptors (D25). */
export type AgentModels = {
	readonly resolve: (role: ConfigRole) => Effect.Effect<FoldModel, RoleResolutionError>
}

const defaultEnv: EnvLookup = (name) => process.env[name]

/** Stamp the requested role onto the resolved model's snapshot (provenance in the durable log). */
const withRole = (model: FoldModel, role: ConfigRole): FoldModel => {
	const activeModel: ActiveModel = { ...model.activeModel, role }
	return { ...model, activeModel }
}

/** Build the resolver over a decoded config. */
export const agentModelsFromConfig = (config: FoldConfig, options?: AgentModelsOptions): AgentModels => {
	const env = options?.env ?? defaultEnv
	const catalog = options?.catalog

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

	/**
	 * The model id one binding runs on: explicit configuration, else the provider kind's default.
	 * openai-compat has no default - the binding must name a model.
	 */
	const modelIdFor = (
		role: ConfigRole,
		binding: RoleBinding,
		provider: ProviderConnection,
	): Effect.Effect<string, RoleResolutionError> => {
		if (binding.model !== undefined) return Effect.succeed(binding.model)

		switch (provider.kind) {
			case 'codex':
				return Effect.succeed(DEFAULT_CODEX_MODEL_ID)
			case 'anthropic':
				return Effect.succeed(DEFAULT_ANTHROPIC_MODEL_ID)
			case 'openai-compat':
				return Effect.fail(
					new RoleResolutionError({
						role,
						message:
							`role "${role}" binds openai-compat provider "${binding.provider}" without a model; ` +
							`models default per provider kind (codex → ${DEFAULT_CODEX_MODEL_ID}, anthropic → ` +
							`${DEFAULT_ANTHROPIC_MODEL_ID}) but a model is required for openai-compat`,
					}),
				)
		}
	}

	/** Resolve one role's binding to its provider-specific model descriptor. */
	const resolveBinding = (role: ConfigRole, binding: RoleBinding): Effect.Effect<FoldModel, RoleResolutionError> =>
		Effect.gen(function* () {
			const providerName = binding.provider
			const provider = config.providers[providerName]
			// Cross-referenced at decode, but guard so a hand-built config can't produce an unclear crash.
			if (provider === undefined) {
				return yield* new RoleResolutionError({
					role,
					message: `role "${role}" references undeclared provider "${providerName}"`,
				})
			}

			const model = yield* modelIdFor(role, binding, provider)
			const reasoning: ReasoningLevel | undefined = binding.reasoning
			const reasoningOption = reasoning === undefined ? {} : { reasoning }
			const baseUrlOption = provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }

			if (provider.kind === 'codex') {
				const apiUrlOption = provider.baseUrl === undefined ? {} : { apiUrl: provider.baseUrl }
				return withRole(
					codexModel({ model, providerId: providerName, ...reasoningOption, ...apiUrlOption }),
					role,
				)
			}

			const apiKey = yield* resolveApiKey(role, providerName, provider)
			const modelOptions = {
				model,
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

	/**
	 * Validate the binding's reasoning level against the catalog (D23): a model whose entry says
	 * `reasoning: false` accepts no level but 'off', and a model with an effort list accepts only the
	 * listed levels. Models the catalog does not know pass through permissively - validation is a
	 * data-driven upgrade, never a gate on unknown models. Runs against the RESOLVED model id, so
	 * bindings that filled a provider default are validated (and reported) as that default.
	 */
	const validateReasoningSupport = (
		role: ConfigRole,
		binding: RoleBinding,
		model: FoldModel,
	): Effect.Effect<void, RoleResolutionError> => {
		const requested = binding.reasoning
		if (catalog === undefined || requested === undefined || requested === 'off') return Effect.void

		const modelId = model.activeModel.modelId
		const entry = lookupCatalogEntry(catalog, model.activeModel)
		if (entry === null) return Effect.void

		if (!entry.reasoning) {
			return Effect.fail(
				new RoleResolutionError({
					role,
					message: `model "${modelId}" does not support reasoning; remove reasoning or use level 'off'`,
				}),
			)
		}

		if (entry.reasoningEfforts !== null && !entry.reasoningEfforts.includes(requested)) {
			return Effect.fail(
				new RoleResolutionError({
					role,
					message:
						`model "${modelId}" does not support reasoning level "${requested}"; ` +
						`supported levels: ${entry.reasoningEfforts.join(', ')} (or 'off')`,
				}),
			)
		}

		return Effect.void
	}

	const resolve = (role: ConfigRole): Effect.Effect<FoldModel, RoleResolutionError> =>
		Effect.gen(function* () {
			const binding = bindingFor(role)
			const model = yield* resolveBinding(role, binding)
			yield* validateReasoningSupport(role, binding, model)

			return model
		})

	return { resolve }
}
