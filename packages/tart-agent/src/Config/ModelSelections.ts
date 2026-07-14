import type { ModelCatalogEntry, TartModel } from '@humanlayer/tart-core'
import { Effect } from 'effect'

import { agentModelsFromConfig, type AgentModelsOptions, RoleResolutionError } from './AgentModels'
import type { ConfigRole, ProfileConfig, ProfileModeName, RoleBinding, TartConfig } from './ConfigSchema'

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
		readonly kind: TartConfig['providers'][string]['kind']
		readonly apiKeyEnv: string | null
		readonly credentialPresent: boolean | null
		readonly models: ReadonlyArray<string>
	}>
}

export type TartModels = {
	readonly root: TartModel
	readonly smart: TartModel
	readonly fast: TartModel
	readonly orchestrator: TartModel
}

const bindings = (config: TartConfig): ReadonlyArray<RoleBinding> => [
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
	config: TartConfig,
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
				: provider.kind === 'codex'
					? [name, 'openai']
					: [name, 'openai']
		const configured = bindings(config)
			.filter((binding) => binding.provider === name && binding.model !== undefined)
			.map((binding) => binding.model as string)
		const catalogModels = catalog
			.filter((entry) => catalogProviderIds.includes(entry.providerId))
			.map((entry) => entry.modelId)
		return {
			name,
			kind: provider.kind,
			apiKeyEnv: provider.apiKeyEnv ?? null,
			credentialPresent:
				provider.kind === 'codex'
					? null
					: provider.apiKeyEnv === undefined
						? provider.apiKey !== undefined && provider.apiKey.length > 0
						: Boolean(env(provider.apiKeyEnv)),
			models: [...new Set([...configured, ...catalogModels])].sort(),
		}
	}),
})

const rolesForProfile = (config: TartConfig, name: string): TartConfig['roles'] | null => {
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

/** Resolve a discriminated UI choice without duplicating provider or credential logic in the caller. */
export const resolveConfiguredModelSelection = (
	config: TartConfig,
	selection: ConfiguredModelSelection,
	mode: ProfileModeName = 'default',
	options?: AgentModelsOptions,
): Effect.Effect<TartModels, RoleResolutionError> => {
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
			const binding: RoleBinding = {
				provider: selection.provider,
				model: selection.model,
				...(selection.reasoning === undefined ? {} : { reasoning: selection.reasoning }),
			}
			roles = { ...roles, [rootRole]: binding }
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
