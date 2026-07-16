import { DEFAULT_CODEX_MODEL_ID } from '@humanlayer/fold-codex'
import { DEFAULT_ANTHROPIC_MODEL_ID, type ModelCatalogEntry, type FoldModel } from '@humanlayer/fold-core'
import { DEFAULT_OPENCODE_MODEL_ID, GROK_BUILD_MODEL_ID } from '@humanlayer/fold-opencode'
import { DEFAULT_XAI_MODEL_ID } from '@humanlayer/fold-xai'
import { Effect } from 'effect'

import { agentModelsFromConfig, type AgentModelsOptions, RoleResolutionError } from './AgentModels'
import type { ConfigRole, ProfileConfig, ProfileModeName, RoleBinding, FoldConfig } from './ConfigSchema'

export type ProfileModelSelection = { readonly _tag: 'profile'; readonly profile: string }
export type DirectModelSelection = {
	readonly _tag: 'direct'
	readonly provider: string
	readonly model: string
	readonly reasoning?: RoleBinding['reasoning']
}
export type ConfiguredModelSelection = ProfileModelSelection | DirectModelSelection

export type ModelConfiguration = {
	readonly profiles: ReadonlyArray<{ readonly name: string; readonly mode: ProfileConfig['mode'] | null }>
	readonly providers: ReadonlyArray<{
		readonly name: string
		readonly kind: FoldConfig['providers'][string]['kind']
		readonly baseUrl?: string | null
		readonly apiKeyEnv: string | null
		readonly credentialPresent: boolean | null
		readonly models: ReadonlyArray<string>
	}>
}

export type FoldModels = {
	readonly root: FoldModel
	readonly smart: FoldModel
	readonly fast: FoldModel
	readonly orchestrator: FoldModel
}

const bindings = (config: FoldConfig): ReadonlyArray<RoleBinding> => [
	config.roles.smart,
	config.roles.fast,
	...(config.roles.orchestrator === undefined ? [] : [config.roles.orchestrator]),
	...Object.values(config.profiles ?? {}).flatMap((profile) => [
		profile.smart,
		profile.fast,
		...(profile.orchestrator === undefined ? [] : [profile.orchestrator]),
	]),
]

/** A secret-free view of selectable config. This is the shared CLI/TUI configuration boundary. */
export const describeModelConfiguration = (
	config: FoldConfig,
	catalog: ReadonlyArray<ModelCatalogEntry> = [],
	env: (name: string) => string | undefined = (name) => process.env[name],
): ModelConfiguration => ({
	profiles: [
		{ name: 'default', mode: null },
		...Object.entries(config.profiles ?? {}).map(([name, profile]) => ({ name, mode: profile.mode ?? null })),
	],
	providers: Object.entries(config.providers).map(([name, provider]) => {
		const catalogProviderIds =
			provider.kind === 'anthropic'
				? [name, 'anthropic']
				: provider.kind === 'codex' || provider.kind === 'opencode'
					? [name, 'openai']
					: provider.kind === 'xai'
						? [name, 'xai']
						: [name, 'openai']
		const configured = bindings(config)
			.filter(
				(binding): binding is typeof binding & { readonly model: string } =>
					binding.provider === name && binding.model !== undefined,
			)
			.map((binding) => binding.model)
		const catalogModels = catalog
			.filter((entry) => catalogProviderIds.includes(entry.providerId))
			.map((entry) => entry.modelId)
		const defaultModels =
			provider.kind === 'codex'
				? [DEFAULT_OPENCODE_MODEL_ID]
				: provider.kind === 'opencode'
					? [DEFAULT_OPENCODE_MODEL_ID, GROK_BUILD_MODEL_ID]
					: provider.kind === 'xai'
						? [DEFAULT_XAI_MODEL_ID]
						: []
		const models =
			provider.kind === 'xai'
				? [DEFAULT_XAI_MODEL_ID]
				: [
						...new Set([
							...defaultModels,
							...(provider.configuredModels ?? []),
							...configured,
							...catalogModels,
						]),
					].sort()
		return {
			name,
			kind: provider.kind,
			baseUrl: provider.baseUrl ?? null,
			apiKeyEnv: provider.apiKeyEnv ?? null,
			credentialPresent:
				provider.kind === 'codex' || provider.kind === 'opencode' || provider.kind === 'xai'
					? null
					: provider.apiKeyEnv === undefined
						? provider.apiKey !== undefined && provider.apiKey.length > 0
						: Boolean(env(provider.apiKeyEnv)),
			models,
		}
	}),
})

const rolesForProfile = (config: FoldConfig, name: string): FoldConfig['roles'] | null => {
	if (name === 'default') return config.roles
	const profile = config.profiles?.[name]
	return profile === undefined
		? null
		: {
				smart: profile.smart,
				fast: profile.fast,
				...(profile.orchestrator === undefined ? {} : { orchestrator: profile.orchestrator }),
			}
}

type DirectProviderSelection = {
	readonly provider: string
	readonly model?: string
	readonly reasoning?: RoleBinding['reasoning']
}

const defaultModelsForProvider = (
	config: FoldConfig,
	selection: DirectProviderSelection,
): Record<ConfigRole, string | undefined> => {
	const kind = config.providers[selection.provider]?.kind
	if (kind === 'codex') return { orchestrator: DEFAULT_CODEX_MODEL_ID, smart: 'gpt-5.6-terra', fast: 'gpt-5.6-luna' }
	if (kind === 'anthropic')
		return { orchestrator: DEFAULT_ANTHROPIC_MODEL_ID, smart: DEFAULT_ANTHROPIC_MODEL_ID, fast: 'claude-sonnet-5' }
	if (kind === 'opencode')
		return {
			orchestrator: DEFAULT_OPENCODE_MODEL_ID,
			smart: DEFAULT_OPENCODE_MODEL_ID,
			fast: DEFAULT_OPENCODE_MODEL_ID,
		}
	if (kind === 'xai')
		return { orchestrator: DEFAULT_XAI_MODEL_ID, smart: DEFAULT_XAI_MODEL_ID, fast: DEFAULT_XAI_MODEL_ID }
	return { orchestrator: selection.model, smart: selection.model, fast: selection.model }
}

/** A direct provider choice creates a provider-local role map; named profiles are the mixed-provider path. */
export const rolesForDirectProviderSelection = (
	config: FoldConfig,
	rootRole: ConfigRole,
	selection: DirectProviderSelection,
): FoldConfig['roles'] => {
	const models = defaultModelsForProvider(config, selection)
	const bindingFor = (role: ConfigRole): RoleBinding => ({
		provider: selection.provider,
		...(models[role] === undefined ? {} : { model: models[role] }),
	})
	const root: RoleBinding = {
		...bindingFor(rootRole),
		...(selection.model === undefined ? {} : { model: selection.model }),
		...(selection.reasoning === undefined ? {} : { reasoning: selection.reasoning }),
	}
	return {
		orchestrator: rootRole === 'orchestrator' ? root : bindingFor('orchestrator'),
		smart: rootRole === 'smart' ? root : bindingFor('smart'),
		fast: rootRole === 'fast' ? root : bindingFor('fast'),
	}
}

/** Resolve a discriminated UI choice without duplicating provider or credential logic in the caller. */
export const resolveConfiguredModelSelection = (
	config: FoldConfig,
	selection: ConfiguredModelSelection,
	mode: ProfileModeName = 'default',
	options?: AgentModelsOptions,
): Effect.Effect<FoldModels, RoleResolutionError> => {
	const rootRole = roleForMode(mode)
	return Effect.gen(function* () {
		let roles = config.roles
		if (selection._tag === 'profile') {
			const profileRoles = rolesForProfile(config, selection.profile)
			if (profileRoles === null) {
				return yield* new RoleResolutionError({
					role: rootRole,
					message: `unknown model profile "${selection.profile}"`,
				})
			}
			roles = profileRoles
		} else {
			roles = rolesForDirectProviderSelection(config, rootRole, selection)
		}

		const resolver = agentModelsFromConfig({ ...config, roles }, options)
		return yield* Effect.all({
			root: resolver.resolve(rootRole),
			smart: resolver.resolve('smart'),
			fast: resolver.resolve('fast'),
			orchestrator: resolver.resolve('orchestrator'),
		})
	})
}

export const roleForMode = (mode: ProfileModeName): ConfigRole => (mode === 'rlm' ? 'orchestrator' : 'smart')
