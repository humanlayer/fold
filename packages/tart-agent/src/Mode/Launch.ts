import { join } from 'node:path'

/**
 * This file is the tart-agent composition root over tart-core's `startSession`/`resumeSession` (D27):
 * it turns a mode + the loaded `TartConfig` + agentfiles into a running coding session, so the CLI and
 * OpenTUI (and callers) never assemble providers/tools/prompts by hand.
 *
 * `launchSession`: resolve the primary model (explicit `model`, else the config role for the mode),
 * load agentfiles for the cwd into a leading prompt block, build the mode's tool roster, prepare a
 * JSONL session log under the D5 layout, and `startSession`.
 *
 * `resumeLatestSession`: discover the newest session log for the cwd (D5) and `resumeSession` with a
 * FRESHLY rebuilt agent - agentfiles and the skills roster are re-read, so tart-core's resume path
 * writes exactly one epoch transition when they changed since the log was written (D17/D20/D22), and
 * nothing when they did not.
 *
 * `resumeSessionById`: resolve an exact `sess_*` id inside the current project's slug directory (the
 * same project-scoped layout pi uses for local session discovery) and adopt that log with the same
 * fresh-agent rebuild semantics as `resumeLatestSession`.
 */
import {
	defineAgent,
	resumeSession,
	SessionId,
	startSession,
	type AgentDefinition,
	type AutoCompactConfig,
	type ModelCatalogEntry,
	type ReasoningLevel,
	type SessionProfiles,
	type SteeringMode,
	type StopConditionConfig,
	type TartModel,
	type TartSession,
	type TartTool,
} from '@humanlayer/tart-core'
import { Effect, Schema, type Scope } from 'effect'

import { loadModelCatalog } from '../Catalog/LoadCatalog'
import { agentModelsFromConfig, type EnvLookup, type RoleResolutionError } from '../Config/AgentModels'
import type { ConfigRole, ProfileModeName, RoleBinding, TartConfig } from '../Config/ConfigSchema'
import {
	defaultTartHome,
	loadTartConfig,
	type ConfigDecodeError,
	type ConfigFileNotFoundError,
	type ConfigParseError,
} from '../Config/Load'
import { jsonlEventLog } from '../EventLog/JsonlDescriptor'
import { memoryPromptBlock } from '../Memory/AgentFiles'
import { latestSessionLog, prepareSessionLog, sessionLogById, type SessionLogRef } from '../Session/SessionLayout'
import { compactionArchiveAccessFor } from './CompactionArchiveAccess'
import { defaultCodingMode, type TartMode } from './Mode'
import { modeForName } from './ModeName'
import { RPI_HINT_PROMPT } from './Rpi'
import type { ModeModels } from './Subagents'

/** A `--profile` name that is not defined under the config's `profiles` map. */
export class UnknownProfileError extends Schema.TaggedErrorClass<UnknownProfileError>()('UnknownProfileError', {
	profile: Schema.String,
	available: Schema.Array(Schema.String),
}) {}

/** Failures resolving the primary model for a launch (config load + profile/role resolution). */
export type LaunchModelError =
	| ConfigFileNotFoundError
	| ConfigParseError
	| ConfigDecodeError
	| RoleResolutionError
	| UnknownProfileError

/** No session log exists for the working directory to resume. */
export class NoSessionToResumeError extends Schema.TaggedErrorClass<NoSessionToResumeError>()(
	'NoSessionToResumeError',
	{
		cwd: Schema.String,
	},
) {}

/** A requested session id does not exist in the current project's session directory. */
export class SessionToResumeNotFoundError extends Schema.TaggedErrorClass<SessionToResumeNotFoundError>()(
	'SessionToResumeNotFoundError',
	{
		cwd: Schema.String,
		sessionId: SessionId,
	},
) {}

/** CLI/OpenTUI-facing model selection: start from a config role and optionally override binding fields. */
export type ModelSelection = {
	/** Role to resolve. Defaults to the selected mode's role (`smart` for the default coding mode). */
	readonly role?: ConfigRole
	/** Provider profile key from `config.providers`; defaults to the selected role's configured provider. */
	readonly provider?: string
	/** Provider model id; defaults to the selected role's configured model. */
	readonly model?: string
	/** Reasoning level; defaults to the selected role's configured reasoning (or provider default). */
	readonly reasoning?: ReasoningLevel
}

/** Shared launch/resume inputs. */
export type LaunchSessionOptions = {
	/** The mode to run. Defaults to {@link defaultCodingMode}. */
	readonly mode?: TartMode
	/**
	 * Install the RPI specialist subagents as additional dispatchable types, composable with any mode
	 * (default false). Also appends the RPI hint block after the mode's system prompt. Resuming with a
	 * different rpi setting is an ordinary configuration change - the existing drift transition applies.
	 */
	readonly rpi?: boolean
	/**
	 * Named profile from `config.profiles` (`--profile`): its role map replaces the top-level `roles`
	 * for this launch, and its pinned `mode` applies unless an explicit `mode` option/flag overrides it.
	 */
	readonly profile?: string
	/** An already-decoded config. When omitted, the config is loaded from `<tartHome>/config.jsonc`. */
	readonly config?: TartConfig
	/** An explicit model, bypassing config/role resolution entirely (no config file needed). */
	readonly model?: TartModel
	/** Config-backed model selection/override used when `model` is omitted. */
	readonly modelSelection?: ModelSelection
	/** The project working directory. Defaults to `process.cwd()`. */
	readonly cwd?: string
	/** The tart home directory (config, sessions). Defaults to `~/.tart`. */
	readonly tartHome?: string
	/** Home directory for the agentfile global chain. Defaults to `os.homedir()`. */
	readonly home?: string
	/** Environment lookup for provider `apiKeyEnv`. Defaults to reading `process.env`. */
	readonly env?: EnvLookup
	/**
	 * Model catalog entries (D15) used for reasoning validation and installed session-wide (compaction
	 * context windows). When omitted, loaded via {@link loadModelCatalog} - cache, models.dev, or the
	 * baked snapshot. Pass an already-loaded catalog to avoid a second load (the CLI loads once).
	 */
	readonly catalog?: ReadonlyArray<ModelCatalogEntry>
	/** Auto-compaction policy (D11). Omitted means disabled. */
	readonly autoCompact?: AutoCompactConfig
	/** Runtime stop-condition policy. Defaults to tart-agent's doom-loop guard. */
	readonly stopConditions?: StopConditionConfig
	/** Steering drain mode (D8). Defaults to one-at-a-time. */
	readonly steering?: SteeringMode
	/** Extra tools appended after the mode's roster (e.g. subagents). */
	readonly extraTools?: ReadonlyArray<TartTool>
	/** Agent display name recorded in `session_started`. Defaults to the mode name. */
	readonly name?: string
}

/** Default runtime guard for product launches: stop repeated identical tool batches without imposing max steps. */
export const defaultStopConditions: StopConditionConfig = {
	doomLoop: { enabled: true, repeatedToolCalls: 3 },
}

/** Auto-compaction defaults match pi: enabled, 16k reserve, and 20k recent-token tail. */
export const defaultAutoCompact: AutoCompactConfig = {
	enabled: true,
}

/**
 * Resolve `--profile`: substitute the profile's role map into the config (top-level `roles` is the
 * default) and surface its pinned mode. Loads the config exactly when a profile is requested; the
 * enriched options carry the substituted config so every later step (role resolution, compaction and
 * stop-condition folds) reads the profile's view without re-loading.
 */
const resolveProfileSelection = (
	opts: LaunchSessionOptions,
): Effect.Effect<
	{ readonly options: LaunchSessionOptions; readonly profileMode: ProfileModeName | null },
	LaunchModelError
> =>
	Effect.gen(function* () {
		if (opts.profile === undefined) return { options: opts, profileMode: null }

		const config =
			opts.config ?? (yield* loadTartConfig(opts.tartHome === undefined ? {} : { tartHome: opts.tartHome }))
		const profile = config.profiles?.[opts.profile]
		if (profile === undefined) {
			return yield* new UnknownProfileError({
				profile: opts.profile,
				available: Object.keys(config.profiles ?? {}),
			})
		}

		const roles = {
			smart: profile.smart,
			fast: profile.fast,
			...(profile.orchestrator === undefined ? {} : { orchestrator: profile.orchestrator }),
		}

		return { options: { ...opts, config: { ...config, roles } }, profileMode: profile.mode ?? null }
	})

/** The mode for a launch: an explicit option wins, then the selected profile's pinned mode, then default. */
const modeFor = (opts: LaunchSessionOptions, profileMode: ProfileModeName | null): TartMode =>
	opts.mode ?? (profileMode === null ? defaultCodingMode : modeForName(profileMode))

const roleBindingFor = (config: TartConfig, role: ConfigRole): RoleBinding =>
	role === 'fast'
		? config.roles.fast
		: role === 'orchestrator'
			? (config.roles.orchestrator ?? config.roles.smart)
			: config.roles.smart

/**
 * Merge a CLI/OpenTUI model selection over a role's configured binding. Field-wise the selection wins,
 * with one cross-provider rule: naming a provider (without a model) whose KIND differs from the base
 * binding's provider kind drops the stale model, so the new kind's default (or openai-compat's
 * required-model error) applies instead of carrying, say, an anthropic model id onto codex. Same-kind
 * provider swaps keep the configured model. Exported for direct unit testing.
 */
export const mergeModelSelection = (config: TartConfig, base: RoleBinding, selection: ModelSelection): RoleBinding => {
	const provider = selection.provider ?? base.provider
	const providerKindChanged =
		selection.provider !== undefined &&
		config.providers[selection.provider]?.kind !== config.providers[base.provider]?.kind
	const model = selection.model ?? (providerKindChanged ? undefined : base.model)
	const reasoning = selection.reasoning ?? base.reasoning

	return {
		provider,
		...(model === undefined ? {} : { model }),
		...(reasoning === undefined ? {} : { reasoning }),
	}
}

const withSelectedRoleBinding = (config: TartConfig, role: ConfigRole, binding: RoleBinding): TartConfig => ({
	...config,
	roles: {
		...config.roles,
		...(role === 'fast'
			? { fast: binding }
			: role === 'orchestrator'
				? { orchestrator: binding }
				: { smart: binding }),
	},
})

/**
 * Resolve every model the mode binds: the primary (the mode's role, or the caller's selection) plus the
 * role models its subagents run on (D21 - a subagent's model is explicit configuration, never inherited).
 * An explicit `model` override bypasses config entirely, so every role collapses onto that one model and
 * a config-less launch stays possible.
 */
const resolveModeModels = (
	options: LaunchSessionOptions,
	mode: TartMode,
	catalog: ReadonlyArray<ModelCatalogEntry>,
): Effect.Effect<ModeModels, LaunchModelError> =>
	Effect.gen(function* () {
		if (options.model !== undefined) {
			const model = options.model
			return { primary: model, smart: model, fast: model, orchestrator: model }
		}

		const selection = options.modelSelection ?? {}
		const role = selection.role ?? mode.role
		const config =
			options.config ??
			(yield* loadTartConfig(options.tartHome === undefined ? {} : { tartHome: options.tartHome }))
		const selectedConfig =
			selection.provider === undefined && selection.model === undefined && selection.reasoning === undefined
				? config
				: withSelectedRoleBinding(
						config,
						role,
						mergeModelSelection(config, roleBindingFor(config, role), selection),
					)
		const models = agentModelsFromConfig(selectedConfig, {
			...(options.env === undefined ? {} : { env: options.env }),
			catalog,
		})

		return {
			primary: yield* models.resolve(role),
			smart: yield* models.resolve('smart'),
			fast: yield* models.resolve('fast'),
			orchestrator: yield* models.resolve('orchestrator'),
		}
	})

/**
 * The self-configuration pointer baked into every leading prompt: where the generated tart guide
 * lives, so the agent can answer configuration questions and edit the config on request.
 */
const tartInfoBlock = (tartHome: string): string =>
	`Tart reference: ${join(tartHome, 'TART_INFO.md')} documents this CLI - its flags (--mode, --profile, ` +
	'--rpi, model overrides), the config file format (providers, roles, named profiles) at ' +
	`${join(tartHome, 'config.jsonc')}, interactive commands, and the managed search binaries. When the user ` +
	'asks how to configure or use tart, read that file first and answer from it. You may edit the config ' +
	'file to reconfigure tart on request; changes bind on the next launch or resume. For source-level questions, ' +
	'point them to https://github.com/humanlayer/tart.'

/** Assemble the agent definition: mode prompt (+ RPI hint) + agentfiles + tart pointer as leading blocks. */
const buildAgentDefinition = (
	options: LaunchSessionOptions,
	mode: TartMode,
	models: ModeModels,
	cwd: string,
	config: TartConfig | null,
): Effect.Effect<AgentDefinition> =>
	Effect.gen(function* () {
		const memoryBlock = yield* memoryPromptBlock({
			cwd,
			...(options.home === undefined ? {} : { home: options.home }),
		})
		// Effective RPI: the flag, or the mode's own default (RLM always carries the specialists).
		const rpi = options.rpi === true || mode.rpiByDefault === true
		const tools = [...mode.buildTools({ cwd, models, rpi }), ...(options.extraTools ?? [])]
		const blocks = [
			...(mode.systemPrompt === undefined ? [] : [mode.systemPrompt]),
			...(rpi ? [RPI_HINT_PROMPT] : []),
			...(memoryBlock === null ? [] : [memoryBlock]),
			tartInfoBlock(options.tartHome ?? defaultTartHome()),
		]
		const autoCompact = options.autoCompact ?? config?.compaction ?? defaultAutoCompact

		return defineAgent({
			name: options.name ?? mode.name,
			model: models.primary,
			tools,
			...(blocks.length === 0 ? {} : { systemPrompt: blocks }),
			autoCompact,
			stopConditions: options.stopConditions ?? config?.stopConditions ?? defaultStopConditions,
		})
	})

/**
 * The session's initial profiles map: the mode's already-resolved role models, so the role-bound
 * default roster resolves at every dispatch and `TartSession.setProfile` swaps take over from there.
 * `agentModelsFromConfig` stamped each model's `activeModel.role`, so role provenance flows into the
 * durable `agent_started.model` of every role-bound child for free.
 */
const sessionProfilesFor = (models: ModeModels): SessionProfiles => ({
	smart: models.smart,
	fast: models.fast,
	orchestrator: models.orchestrator,
})

const runtimeConfigFor = (options: LaunchSessionOptions): Effect.Effect<TartConfig | null, LaunchModelError> => {
	if (options.config !== undefined) return Effect.succeed(options.config)
	if (options.model !== undefined) return Effect.succeed(null)

	return loadTartConfig(options.tartHome === undefined ? {} : { tartHome: options.tartHome })
}

/** The catalog for a launch: the caller's (the CLI loads once), else a fresh load (never fails). */
const catalogFor = (options: LaunchSessionOptions): Effect.Effect<ReadonlyArray<ModelCatalogEntry>> =>
	options.catalog !== undefined
		? Effect.succeed(options.catalog)
		: loadModelCatalog({
				tartHome: options.tartHome ?? defaultTartHome(),
				...(options.env === undefined ? {} : { env: options.env }),
			})

/**
 * Start a fresh coding session: resolve the model, load agentfiles, build the mode's tools, and
 * `startSession` over a JSONL log named by a freshly minted session id under the D5 layout.
 */
export const launchSession = (
	options?: LaunchSessionOptions,
): Effect.Effect<TartSession, LaunchModelError, Scope.Scope> =>
	Effect.gen(function* () {
		const { options: opts, profileMode } = yield* resolveProfileSelection(options ?? {})
		const mode = modeFor(opts, profileMode)
		const cwd = opts.cwd ?? process.cwd()

		// The catalog loads before model resolution: role bindings validate reasoning against it (D23).
		const catalog = yield* catalogFor(opts)
		const models = yield* resolveModeModels(opts, mode, catalog)
		const config = yield* runtimeConfigFor(opts)
		const agent = yield* buildAgentDefinition(opts, mode, models, cwd, config)

		const prepared = yield* prepareSessionLog({
			cwd,
			...(opts.tartHome === undefined ? {} : { tartHome: opts.tartHome }),
		})

		return yield* startSession({
			agent,
			log: prepared.log,
			cwd,
			sessionId: prepared.sessionId,
			profiles: sessionProfilesFor(models),
			catalog,
			compactionArchiveAccess: compactionArchiveAccessFor({ logPath: prepared.path, modeName: mode.name }),
			...(opts.steering === undefined ? {} : { steering: opts.steering }),
		})
	})

const resumeFromLog = (
	log: SessionLogRef,
	options: LaunchSessionOptions,
	mode: TartMode,
	cwd: string,
): Effect.Effect<TartSession, LaunchModelError, Scope.Scope> =>
	Effect.gen(function* () {
		// Same order as launchSession: the catalog loads before model resolution (D23 validation).
		const catalog = yield* catalogFor(options)
		const models = yield* resolveModeModels(options, mode, catalog)
		const config = yield* runtimeConfigFor(options)
		const agent = yield* buildAgentDefinition(options, mode, models, cwd, config)

		return yield* resumeSession({
			agent,
			log: jsonlEventLog(log.path),
			profiles: sessionProfilesFor(models),
			catalog,
			compactionArchiveAccess: compactionArchiveAccessFor({ logPath: log.path, modeName: mode.name }),
			...(options.steering === undefined ? {} : { steering: options.steering }),
		})
	})

/**
 * Resume the newest session log for the working directory (D5 discovery). The agent is rebuilt fresh -
 * a freshly scanned skills roster and re-read agentfiles - so tart-core's resume path writes one epoch
 * transition iff the configuration changed since the log was written, and nothing when it matches.
 */
export const resumeLatestSession = (
	options?: LaunchSessionOptions,
): Effect.Effect<TartSession, LaunchModelError | NoSessionToResumeError, Scope.Scope> =>
	Effect.gen(function* () {
		const { options: opts, profileMode } = yield* resolveProfileSelection(options ?? {})
		const mode = modeFor(opts, profileMode)
		const cwd = opts.cwd ?? process.cwd()

		const latest = yield* latestSessionLog({
			cwd,
			...(opts.tartHome === undefined ? {} : { tartHome: opts.tartHome }),
		})
		if (latest === null) return yield* new NoSessionToResumeError({ cwd })

		return yield* resumeFromLog(latest, opts, mode, cwd)
	})

/**
 * Resume a specific session id from the current project's session directory. This intentionally stays
 * project-scoped (matching the D5 layout): `sess_*` ids are resolved under `~/.tart/sessions/<slug>/`,
 * not by walking every project directory.
 */
export const resumeSessionById = (
	sessionId: SessionId,
	options?: LaunchSessionOptions,
): Effect.Effect<TartSession, LaunchModelError | SessionToResumeNotFoundError, Scope.Scope> =>
	Effect.gen(function* () {
		const { options: opts, profileMode } = yield* resolveProfileSelection(options ?? {})
		const mode = modeFor(opts, profileMode)
		const cwd = opts.cwd ?? process.cwd()

		const log = yield* sessionLogById(sessionId, {
			cwd,
			...(opts.tartHome === undefined ? {} : { tartHome: opts.tartHome }),
		})
		if (log === null) return yield* new SessionToResumeNotFoundError({ cwd, sessionId })

		return yield* resumeFromLog(log, opts, mode, cwd)
	})
