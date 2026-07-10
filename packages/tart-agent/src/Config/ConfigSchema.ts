/**
 * This file defines the `TartConfig` Effect Schema (D25): the single `~/.tart/config.jsonc` shape,
 * schema-first with decode-time validation and a total domain type (§3 conventions). Connections and
 * roles are split so roles can bind cross-provider by construction - a role names a provider profile
 * plus a model, and the provider profile carries the kind, base URL, and credential source.
 *
 * The same schema drives three things: decoding the JSONC file (Config/Load), generating the editor
 * JSON Schema (Config/ConfigSchemaJson), and resolving a role to a runnable model (Config/AgentModels).
 * A cross-reference check rejects a config whose roles point at providers that were never declared, so
 * `AgentModels.resolve` only ever fails on a genuinely runtime condition (a missing credential env var).
 *
 * `apiKey` stays a plain string in the schema (the file is human-editable and home-only); it is wrapped
 * in `Redacted` at the provider edge in AgentModels, never before. `apiKeyEnv` is the preferred form.
 */
import { ReasoningLevel } from '@humanlayer/tart-core'
import type { AutoCompactConfig as CoreAutoCompactConfig, StopConditionConfig } from '@humanlayer/tart-core'
import { Schema } from 'effect'

/** How a configured provider profile is reached. */
export const ProviderKind = Schema.Literals(['anthropic', 'openai-compat', 'codex']).annotate({
	identifier: 'ProviderKind',
	description:
		'anthropic (Anthropic-compatible), openai-compat (OpenAI-compatible), or codex (ChatGPT Codex backend)',
})
export type ProviderKind = typeof ProviderKind.Type

/**
 * One provider connection profile. `codex` needs no credential here (it uses `~/.tart/auth.json`);
 * `anthropic` and `openai-compat` resolve their key from `apiKeyEnv` (preferred) or inline `apiKey`.
 */
export const ProviderConnection = Schema.Struct({
	kind: ProviderKind,
	/** Override the provider base URL (a compatible proxy, or the Codex backend). */
	baseUrl: Schema.optionalKey(Schema.String.annotate({ description: 'Override the provider base URL' })),
	/** Name of the environment variable holding the API key (preferred over inline `apiKey`). */
	apiKeyEnv: Schema.optionalKey(
		Schema.String.annotate({ description: 'Environment variable holding the API key (preferred)' }),
	),
	/** Inline API key. Tolerated for this home-only file; prefer `apiKeyEnv`. */
	apiKey: Schema.optionalKey(Schema.String.annotate({ description: 'Inline API key (prefer apiKeyEnv)' })),
}).annotate({ identifier: 'ProviderConnection', description: 'A provider connection profile' })
export type ProviderConnection = typeof ProviderConnection.Type

/** One role binding: which provider profile, optionally which model on it, and a reasoning level. */
export const RoleBinding = Schema.Struct({
	/** The `providers` key this role runs on. */
	provider: Schema.String.annotate({ description: 'A key from the `providers` map' }),
	/** The provider model id; omitted means the provider kind's default (openai-compat has none). */
	model: Schema.optionalKey(
		Schema.String.annotate({
			description:
				'Provider model id; defaults per provider kind: codex → gpt-5.6-sol, anthropic → claude-opus-4-8; required for openai-compat',
		}),
	),
	/** Reasoning level for this role's requests. Defaults to `off` when omitted. */
	reasoning: Schema.optionalKey(ReasoningLevel),
}).annotate({ identifier: 'RoleBinding', description: 'A model binding for one role' })
export type RoleBinding = typeof RoleBinding.Type

/**
 * The role map (D25, user ruling: 2-3 roles). `smart` and `fast` are required; `orchestrator` is
 * optional and falls back to `smart` when unset (the RLM preset's orchestrator uses it).
 */
export const RolesConfig = Schema.Struct({
	/** The strong general-purpose model (default for the coding mode's primary agent). */
	smart: RoleBinding,
	/** A cheaper/faster model for lightweight work (compaction summaries, simple subagents). */
	fast: RoleBinding,
	/** Optional orchestrator model for RLM-style delegation; falls back to `smart` when unset. */
	orchestrator: Schema.optionalKey(RoleBinding),
}).annotate({ identifier: 'RolesConfig', description: 'Cross-provider model roles' })
export type RolesConfig = typeof RolesConfig.Type

/** The three resolvable config role names. `orchestrator` falls back to `smart` when unbound. */
export const ConfigRole = Schema.Literals(['orchestrator', 'smart', 'fast']).annotate({ identifier: 'ConfigRole' })
export type ConfigRole = typeof ConfigRole.Type

/**
 * Mode names a profile may pin. A config-side literal copy of `TART_MODE_NAMES` (Mode/ModeName.ts) -
 * importing it here would cycle Config -> Mode -> Config; a test asserts the two stay in sync.
 */
export const ProfileModeName = Schema.Literals(['default', 'rlm']).annotate({
	identifier: 'ProfileModeName',
	description: 'Agent mode this profile selects (an explicit --mode flag still wins)',
})
export type ProfileModeName = typeof ProfileModeName.Type

/**
 * One named profile: a complete role map plus, optionally, the agent mode it is meant to drive
 * (the shipped `ultraclaude`/`ultracodex` presets pin `rlm`). Selected with `--profile <name>`.
 */
export const ProfileConfig = Schema.Struct({
	/** The strong general-purpose model for this profile. */
	smart: RoleBinding,
	/** The cheaper/faster model for this profile. */
	fast: RoleBinding,
	/** Optional orchestrator model; falls back to this profile's `smart` when unset. */
	orchestrator: Schema.optionalKey(RoleBinding),
	/** Agent mode this profile selects. Omit to keep the launch's mode (default, or --mode). */
	mode: Schema.optionalKey(ProfileModeName),
}).annotate({ identifier: 'ProfileConfig', description: 'A named role map, optionally pinning an agent mode' })
export type ProfileConfig = typeof ProfileConfig.Type

/** Auto-compaction policy for sessions launched through tart-agent. */
export const AutoCompactConfig = Schema.Union([
	Schema.Struct({ enabled: Schema.Literal(false) }),
	Schema.Struct({
		enabled: Schema.Literal(true),
		compactionPrompt: Schema.optionalKey(Schema.String),
		thresholdTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
		contextWindow: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
		reserveTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
		keepRecentTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
	}),
]).annotate({ identifier: 'AutoCompactConfig', description: 'Auto-compaction policy' })
export type AutoCompactConfig = typeof AutoCompactConfig.Type & CoreAutoCompactConfig

/** Doom-loop stop condition configuration. */
export const DoomLoopStopCondition = Schema.Union([
	Schema.Struct({ enabled: Schema.Literal(false) }),
	Schema.Struct({
		enabled: Schema.Literal(true),
		repeatedToolCalls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)).annotate({
			description: 'Consecutive identical tool-call batches before the run stops gracefully',
		}),
	}),
]).annotate({ identifier: 'DoomLoopStopCondition', description: 'Repeated-tool-call doom-loop detector' })

/** Runtime stop conditions for sessions launched through tart-agent. */
export const StopConditionsConfig = Schema.Struct({
	doomLoop: Schema.optionalKey(DoomLoopStopCondition),
}).annotate({ identifier: 'StopConditionsConfig', description: 'Runtime stop conditions' })
export type StopConditionsConfig = typeof StopConditionsConfig.Type & StopConditionConfig

const TartConfigFields = {
	/** Path to the generated JSON Schema, for editor validation/completion. */
	$schema: Schema.optionalKey(Schema.String),
	/** Named provider connection profiles. */
	providers: Schema.Record(Schema.String, ProviderConnection),
	/** Cross-provider model roles. */
	roles: RolesConfig,
	/**
	 * Named profiles selected with `--profile <name>` (the top-level `roles` stays the default).
	 * Each profile is a complete role map (smart + fast required, orchestrator optional) and may pin
	 * an agent mode. tart ships `ultraclaude` and `ultracodex` RLM presets in the starter config.
	 */
	profiles: Schema.optionalKey(
		Schema.Record(Schema.String, ProfileConfig).annotate({
			description: 'Named profiles selectable with --profile <name>; may pin a mode; `roles` is the default',
		}),
	),
	/** Auto-compaction policy. Omit to use tart-agent defaults (enabled today). */
	compaction: Schema.optionalKey(AutoCompactConfig),
	/** Runtime stop conditions. Omit to use tart-agent defaults. */
	stopConditions: Schema.optionalKey(StopConditionsConfig),
}

/** The value shape the cross-reference check reads (a structural supertype of the decoded config). */
type RoleBindingRef = { readonly provider: string }
type RolesRef = {
	readonly smart: RoleBindingRef
	readonly fast: RoleBindingRef
	readonly orchestrator?: RoleBindingRef
}
type CrossRefShape = {
	readonly providers: Record<string, unknown>
	readonly roles: RolesRef
	readonly profiles?: Record<string, RolesRef>
}

const bindingsOf = (roles: RolesRef): ReadonlyArray<RoleBindingRef> => [
	roles.smart,
	roles.fast,
	...(roles.orchestrator === undefined ? [] : [roles.orchestrator]),
]

/**
 * Every provider a role binds to - in the default `roles` map AND in every named profile - must be
 * declared in `providers` (decode-time typo/reference safety).
 */
const providersReferencedByRolesExist = Schema.makeFilter<CrossRefShape>(
	({ providers, roles, profiles }) => {
		const declared = new Set(Object.keys(providers))
		const bindings = [...bindingsOf(roles), ...Object.values(profiles ?? {}).flatMap(bindingsOf)]
		const missing = [...new Set(bindings.map((binding) => binding.provider).filter((name) => !declared.has(name)))]
		return missing.length === 0
			? undefined
			: `roles reference undeclared providers: ${missing.join(', ')} (declared: ${[...declared].join(', ') || '(none)'})`
	},
	{ identifier: 'ProvidersReferencedByRolesExist' },
)

/** The whole `~/.tart/config.jsonc` document. Unknown top-level keys are rejected at decode (D25). */
export const TartConfig = Schema.Struct(TartConfigFields)
	.check(providersReferencedByRolesExist)
	.annotate({ identifier: 'TartConfig', description: 'tart configuration (~/.tart/config.jsonc)' })
export type TartConfig = typeof TartConfig.Type
