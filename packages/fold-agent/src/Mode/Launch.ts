import { join } from 'node:path'

/**
 * This file is the fold-agent composition root over fold-core's `startSession`/`resumeSession` (D27):
 * it turns a mode + the loaded `FoldConfig` + agentfiles into a running coding session, so the CLI and
 * OpenTUI (and callers) never assemble providers/tools/prompts by hand.
 *
 * `launchSession`: resolve the primary model (explicit `model`, else the config role for the mode),
 * load agentfiles for the cwd into a leading prompt block, build the mode's tool roster, prepare a
 * JSONL session log under the D5 layout, and `startSession`.
 *
 * `resumeLatestSession`: discover the newest session log for the cwd (D5) and `resumeSession` with a
 * FRESHLY rebuilt agent - agentfiles and the skills roster are re-read, so fold-core's resume path
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
	type FoldModel,
	type FoldSession,
	type FoldTool,
	type Ids,
} from '@humanlayer/fold-core'
import { Predicate, Effect, FileSystem, Layer, Match, Schema, Semaphore, type Scope } from 'effect'

import { loadModelCatalog } from '../Catalog/LoadCatalog'
import { agentModelsFromConfig, type EnvLookup, type RoleResolutionError } from '../Config/AgentModels'
import type { ConfigRole, ProfileModeName, RoleBinding, FoldConfig } from '../Config/ConfigSchema'
import {
	defaultFoldHome,
	loadFoldConfig,
	type ConfigDecodeError,
	type ConfigFileNotFoundError,
	type ConfigParseError,
} from '../Config/Load'
import { rolesForDirectProviderSelection } from '../Config/ModelSelections'
import { jsonlEventLog } from '../EventLog/JsonlDescriptor'
import { memoryPromptBlock } from '../Memory/AgentFiles'
import { makeOutputStore, type OutputStoreService } from '../OutputStore/OutputStore'
import {
	latestSessionLog,
	prepareSessionLog,
	refreshSessionSummaryIndex,
	sessionLogById,
	type SessionLogRef,
} from '../Session/SessionLayout'
import { generateSessionTitle } from '../Session/TitleGenerator'
import { compactionArchiveAccessFor } from './CompactionArchiveAccess'
import { defaultCodingMode, type FoldMode } from './Mode'
import { modeForName } from './ModeName'
import { RPI_HINT_PROMPT } from './Rpi'
import type { ModeModels } from './Subagents'

/** A `--profile` name that is not defined under the config's `profiles` map. */
export class UnknownProfileError extends Schema.TaggedError<UnknownProfileError>()('UnknownProfileError', {
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
export class NoSessionToResumeError extends Schema.TaggedError<NoSessionToResumeError>()('NoSessionToResumeError', {
	cwd: Schema.String,
}) {}

/** A requested session id does not exist in the current project's session directory. */
export class SessionToResumeNotFoundError extends Schema.TaggedError<SessionToResumeNotFoundError>()(
	'SessionToResumeNotFoundError',
	{
		cwd: Schema.String,
		sessionId: SessionId,
	},
) {}

/** CLI/OpenTUI-facing model selection: a provider choice uses its role defaults; other fields override one role. */
export type ModelSelection = {
	/** Role to resolve. Defaults to the selected mode's role (`smart` for the default coding mode). */
	readonly role?: ConfigRole
	/** Provider profile key from `config.providers`; when set, all session roles use that provider's defaults. */
	readonly provider?: string
	/** Provider model id for the selected root role; other roles retain the selected provider's defaults. */
	readonly model?: string
	/** Reasoning level; defaults to the selected role's configured reasoning (or provider default). */
	readonly reasoning?: ReasoningLevel
}

/** Shared launch/resume inputs. */
export type LaunchSessionOptions = {
	/** The mode to run. Defaults to {@link defaultCodingMode}. */
	readonly mode?: FoldMode
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
	/** An already-decoded config. When omitted, the config is loaded from `<foldHome>/config.jsonc`. */
	readonly config?: FoldConfig
	/** An explicit model, bypassing config/role resolution entirely (no config file needed). */
	readonly model?: FoldModel
	/** Config-backed model selection/override used when `model` is omitted. */
	readonly modelSelection?: ModelSelection
	/** The project working directory. Defaults to `process.cwd()`. */
	readonly cwd?: string
	/** The fold home directory (config, sessions). Defaults to `~/.fold`. */
	readonly foldHome?: string
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
	/** Runtime stop-condition policy. Defaults to fold-agent's doom-loop guard. */
	readonly stopConditions?: StopConditionConfig
	/** Steering drain mode (D8). Defaults to one-at-a-time. */
	readonly steering?: SteeringMode
	/** Extra tools appended after the mode's roster (e.g. subagents). */
	readonly extraTools?: ReadonlyArray<FoldTool>
	/** Agent display name recorded in `session_started`. Defaults to the mode name. */
	readonly name?: string
}

/** Inputs for switching an existing session to a freshly composed selectable mode. */
export type SwitchSessionModeOptions = Pick<
	LaunchSessionOptions,
	| 'cwd'
	| 'foldHome'
	| 'home'
	| 'env'
	| 'config'
	| 'catalog'
	| 'rpi'
	| 'profile'
	| 'modelSelection'
	| 'model'
	| 'extraTools'
> & {
	/** Target mode. Its prompt, tools, default role, and RPI default are rebuilt exactly as at launch. */
	readonly mode: FoldMode
	/** Durable explanation attached to the D17 model-change row. */
	readonly reason?: string
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
	LaunchModelError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		if (opts.profile === undefined) return { options: opts, profileMode: null }

		const config =
			opts.config ?? (yield* loadFoldConfig(opts.foldHome === undefined ? {} : { foldHome: opts.foldHome }))
		const profile = config.profiles?.[opts.profile]
		if (profile === undefined) {
			return yield* new UnknownProfileError({
				profile: opts.profile,
				available: Object.keys(config.profiles ?? {}),
			})
		}

		const roles =
			profile.orchestrator === undefined
				? { smart: profile.smart, fast: profile.fast }
				: { smart: profile.smart, fast: profile.fast, orchestrator: profile.orchestrator }

		return { options: { ...opts, config: { ...config, roles } }, profileMode: profile.mode ?? null }
	})

/** The mode for a launch: an explicit option wins, then the selected profile's pinned mode, then default. */
const modeFor = (opts: LaunchSessionOptions, profileMode: ProfileModeName | null): FoldMode =>
	opts.mode ?? (profileMode === null ? defaultCodingMode : modeForName(profileMode))

const roleBindingFor = (config: FoldConfig, role: ConfigRole): RoleBinding =>
	Match.value(role).pipe(
		Match.when('fast', () => config.roles.fast),
		Match.when('orchestrator', () => config.roles.orchestrator ?? config.roles.smart),
		Match.when('smart', () => config.roles.smart),
		Match.exhaustive,
	)

/**
 * Merge a CLI/OpenTUI model selection over a role's configured binding. Field-wise the selection wins,
 * with one cross-provider rule: naming a provider (without a model) whose KIND differs from the base
 * binding's provider kind drops the stale model, so the new kind's default (or openai-compat's
 * required-model error) applies instead of carrying, say, an anthropic model id onto codex. Same-kind
 * provider swaps keep the configured model. Exported for direct unit testing.
 */
export const mergeModelSelection = (config: FoldConfig, base: RoleBinding, selection: ModelSelection): RoleBinding => {
	const provider = selection.provider ?? base.provider
	const providerKindChanged =
		selection.provider !== undefined &&
		config.providers[selection.provider]?.kind !== config.providers[base.provider]?.kind
	const model = selection.model ?? (providerKindChanged ? undefined : base.model)
	const reasoning = selection.reasoning ?? base.reasoning

	if (model === undefined) return reasoning === undefined ? { provider } : { provider, reasoning }
	return reasoning === undefined ? { provider, model } : { provider, model, reasoning }
}

const withSelectedRoleBinding = (config: FoldConfig, role: ConfigRole, binding: RoleBinding): FoldConfig => ({
	...config,
	roles: {
		...config.roles,
		...Match.value(role).pipe(
			Match.when('fast', () => ({ fast: binding })),
			Match.when('orchestrator', () => ({ orchestrator: binding })),
			Match.when('smart', () => ({ smart: binding })),
			Match.exhaustive,
		),
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
	mode: FoldMode,
	catalog: ReadonlyArray<ModelCatalogEntry>,
): Effect.Effect<ModeModels, LaunchModelError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		if (options.model !== undefined) {
			const model = options.model
			return { primary: model, smart: model, fast: model, orchestrator: model }
		}

		const selection = options.modelSelection ?? {}
		const role = selection.role ?? mode.role
		const config =
			options.config ??
			(yield* loadFoldConfig(options.foldHome === undefined ? {} : { foldHome: options.foldHome }))
		let selectedConfig: FoldConfig
		if (selection.provider !== undefined) {
			const directProviderSelection =
				selection.model === undefined
					? selection.reasoning === undefined
						? { provider: selection.provider }
						: { provider: selection.provider, reasoning: selection.reasoning }
					: selection.reasoning === undefined
						? { provider: selection.provider, model: selection.model }
						: { provider: selection.provider, model: selection.model, reasoning: selection.reasoning }
			selectedConfig = {
				...config,
				roles: rolesForDirectProviderSelection(config, role, directProviderSelection),
			}
		} else if (selection.model === undefined && selection.reasoning === undefined) {
			selectedConfig = config
		} else {
			selectedConfig = withSelectedRoleBinding(
				config,
				role,
				mergeModelSelection(config, roleBindingFor(config, role), selection),
			)
		}
		const modelOptions = options.env === undefined ? { catalog } : { env: options.env, catalog }
		const models = agentModelsFromConfig(selectedConfig, modelOptions)

		return {
			primary: yield* models.resolve(role),
			smart: yield* models.resolve('smart'),
			fast: yield* models.resolve('fast'),
			orchestrator: yield* models.resolve('orchestrator'),
		}
	})

/**
 * The self-configuration pointer baked into every leading prompt: where the generated fold guide
 * lives, so the agent can answer configuration questions and edit the config on request.
 */
const foldInfoBlock = (foldHome: string): string =>
	`Fold reference: ${join(foldHome, 'FOLD_INFO.md')} documents this CLI - its flags (--mode, --profile, ` +
	'--rpi, model overrides), the config file format (providers, roles, named profiles) at ' +
	`${join(foldHome, 'config.jsonc')}, interactive commands, and the managed search binaries. When the user ` +
	'asks how to configure or use fold, read that file first and answer from it. You may edit the config ' +
	'file to reconfigure fold on request; changes bind on the next launch or resume. For source-level questions, ' +
	'point them to https://github.com/humanlayer/fold.'

const modelStyleBlock = 'Do not use emoticons.'

/** Assemble the agent definition: mode prompt (+ RPI hint) + agentfiles + fold pointer as leading blocks. */
const buildAgentDefinition = (
	options: LaunchSessionOptions,
	mode: FoldMode,
	models: ModeModels,
	cwd: string,
	config: FoldConfig | null,
	outputStore: OutputStoreService,
): Effect.Effect<AgentDefinition, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const memoryBlock = yield* memoryPromptBlock(options.home === undefined ? { cwd } : { cwd, home: options.home })
		// Effective RPI: the flag, or the mode's own default (RLM always carries the specialists).
		const rpi = options.rpi === true || mode.rpiByDefault === true
		const tools = [...mode.buildTools({ cwd, models, rpi, outputStore }), ...(options.extraTools ?? [])]
		const blocks = [
			...(mode.systemPrompt === undefined ? [] : [mode.systemPrompt]),
			modelStyleBlock,
			...(rpi ? [RPI_HINT_PROMPT] : []),
			...(memoryBlock === null ? [] : [memoryBlock]),
			foldInfoBlock(options.foldHome ?? defaultFoldHome()),
		]
		const autoCompact = options.autoCompact ?? config?.compaction ?? defaultAutoCompact
		const agentOptions = {
			name: options.name ?? mode.name,
			model: models.primary,
			tools,
			autoCompact,
			stopConditions: options.stopConditions ?? config?.stopConditions ?? defaultStopConditions,
		}
		return defineAgent(blocks.length === 0 ? agentOptions : { ...agentOptions, systemPrompt: blocks })
	})

/**
 * The session's initial profiles map: the mode's already-resolved role models, so the role-bound
 * default roster resolves at every dispatch and `FoldSession.setProfile` swaps take over from there.
 * `agentModelsFromConfig` stamped each model's `activeModel.role`, so role provenance flows into the
 * durable `agent_started.model` of every role-bound child for free.
 */
const sessionProfilesFor = (models: ModeModels): SessionProfiles => ({
	smart: models.smart,
	fast: models.fast,
	orchestrator: models.orchestrator,
})

/**
 * Recompose and install a selectable mode on an existing session without replacing its identity or
 * event log. Model/profile resolution, agentfiles, RPI prompt/roster, fold-info block, and mode tools
 * use the same helpers as launch/resume. The three role bindings are rebound before the atomic root
 * epoch switch so newly introduced role-bound subagent types are covered at the switch boundary.
 */
export const switchSessionMode = (
	session: FoldSession,
	options: SwitchSessionModeOptions,
): Effect.Effect<void, LaunchModelError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const { options: profiled } = yield* resolveProfileSelection(options)
		const mode = options.mode
		const cwd = profiled.cwd ?? process.cwd()
		const catalog = yield* catalogFor(profiled)
		const models = yield* resolveModeModels(profiled, mode, catalog)
		const config = yield* runtimeConfigFor(profiled)
		const outputStore = yield* makeOutputStore(
			profiled.foldHome === undefined
				? { sessionId: session.sessionId }
				: { sessionId: session.sessionId, foldHome: profiled.foldHome },
		)
		yield* outputStore.sweep
		const agent = yield* buildAgentDefinition(profiled, mode, models, cwd, config, outputStore)

		const defaultSwitchOptions = {
			reason: options.reason ?? `switch mode to ${mode.name}`,
			profiles: sessionProfilesFor(models),
		}
		const switchOptions =
			agent.systemPrompt === undefined
				? agent.tools === undefined
					? defaultSwitchOptions
					: {
							...defaultSwitchOptions,
							tools: agent.tools,
						}
				: agent.tools === undefined
					? {
							...defaultSwitchOptions,
							systemPrompt: agent.systemPrompt,
						}
					: {
							...defaultSwitchOptions,
							systemPrompt: agent.systemPrompt,
							tools: agent.tools,
						}
		yield* session.switchModel(models.primary, switchOptions)
	})

const withGeneratedTitles = (
	session: FoldSession,
	model: FoldModel,
	options: { readonly cwd: string; readonly foldHome?: string },
): Effect.Effect<FoldSession, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const fsLayer = Layer.succeed(FileSystem.FileSystem, fs)
		return yield* Semaphore.make(1).pipe(
			Effect.map((titleLock) => ({
				...session,
				send: (text: string, target?: Parameters<FoldSession['send']>[1]) =>
					session.send(text, target).pipe(
						Effect.tap(() => {
							if (target?.agentId !== undefined && target.agentId !== session.rootAgentId)
								return Effect.void
							return titleLock.withPermit(
								Effect.exit(
									session.entries.pipe(
										Effect.flatMap((entries) => {
											const rootUsers = entries.filter(
												(entry) =>
													Predicate.isTagged(entry, 'user-message') &&
													entry.agentId === session.rootAgentId,
											)
											const lastTitle = entries.findLast((entry) =>
												Predicate.isTagged(entry, 'session_title'),
											)
											const generatedTurns = lastTitle?.rootUserTurns ?? 0
											if (rootUsers.length <= generatedTurns) return Effect.void
											return generateSessionTitle(entries, session.rootAgentId, model).pipe(
												Effect.flatMap((title) => {
													const generatedThroughSeq = entries.at(-1)?.seq
													const setTitle =
														generatedThroughSeq === undefined
															? session.setTitle(title, {
																	rootUserTurns: rootUsers.length,
																})
															: session.setTitle(title, {
																	generatedThroughSeq,
																	rootUserTurns: rootUsers.length,
																})
													return setTitle.pipe(
														Effect.andThen(
															refreshSessionSummaryIndex(session.sessionId, options).pipe(
																Effect.provide(fsLayer),
															),
														),
													)
												}),
											)
										}),
									),
								).pipe(Effect.asVoid),
							)
						}),
					),
			})),
		)
	})

const runtimeConfigFor = (
	options: LaunchSessionOptions,
): Effect.Effect<FoldConfig | null, LaunchModelError, FileSystem.FileSystem> => {
	if (options.config !== undefined) return Effect.succeed(options.config)
	if (options.model !== undefined) return Effect.succeed(null)

	return loadFoldConfig(options.foldHome === undefined ? {} : { foldHome: options.foldHome })
}

/** The catalog for a launch: the caller's (the CLI loads once), else a fresh load (never fails). */
const catalogFor = (
	options: LaunchSessionOptions,
): Effect.Effect<ReadonlyArray<ModelCatalogEntry>, never, FileSystem.FileSystem> =>
	options.catalog !== undefined
		? Effect.succeed(options.catalog)
		: loadModelCatalog(
				options.env === undefined
					? { foldHome: options.foldHome ?? defaultFoldHome() }
					: { foldHome: options.foldHome ?? defaultFoldHome(), env: options.env },
			)

/**
 * Start a fresh coding session: resolve the model, load agentfiles, build the mode's tools, and
 * `startSession` over a JSONL log named by a freshly minted session id under the D5 layout.
 */
export const launchSession = (
	options?: LaunchSessionOptions,
): Effect.Effect<FoldSession, LaunchModelError, Scope.Scope | Ids | FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const { options: opts, profileMode } = yield* resolveProfileSelection(options ?? {})
		const mode = modeFor(opts, profileMode)
		const cwd = opts.cwd ?? process.cwd()

		// The catalog loads before model resolution: role bindings validate reasoning against it (D23).
		const catalog = yield* catalogFor(opts)
		const models = yield* resolveModeModels(opts, mode, catalog)
		const config = yield* runtimeConfigFor(opts)
		const prepared = yield* prepareSessionLog(
			opts.foldHome === undefined ? { cwd } : { cwd, foldHome: opts.foldHome },
		)
		const outputStore = yield* makeOutputStore(
			opts.foldHome === undefined
				? { sessionId: prepared.sessionId }
				: { sessionId: prepared.sessionId, foldHome: opts.foldHome },
		)
		yield* outputStore.sweep
		const agent = yield* buildAgentDefinition(opts, mode, models, cwd, config, outputStore)

		const startOptions = {
			agent,
			log: prepared.log,
			cwd,
			sessionId: prepared.sessionId,
			meta: {
				mode: mode.name,
				rpi: opts.rpi === true || mode.rpiByDefault === true,
				profile: opts.profile ?? 'default',
			},
			profiles: sessionProfilesFor(models),
			catalog,
			compactionArchiveAccess: compactionArchiveAccessFor({ logPath: prepared.path, modeName: mode.name }),
		}
		const session = yield* startSession(
			opts.steering === undefined ? startOptions : { ...startOptions, steering: opts.steering },
		)
		return yield* withGeneratedTitles(
			session,
			models.fast,
			opts.foldHome === undefined ? { cwd } : { cwd, foldHome: opts.foldHome },
		)
	})

const resumeFromLog = (
	log: SessionLogRef,
	options: LaunchSessionOptions,
	mode: FoldMode,
	cwd: string,
): Effect.Effect<FoldSession, LaunchModelError, Scope.Scope | FileSystem.FileSystem> =>
	Effect.gen(function* () {
		// Same order as launchSession: the catalog loads before model resolution (D23 validation).
		const catalog = yield* catalogFor(options)
		const models = yield* resolveModeModels(options, mode, catalog)
		const config = yield* runtimeConfigFor(options)
		const outputStore = yield* makeOutputStore(
			options.foldHome === undefined
				? { sessionId: log.sessionId }
				: { sessionId: log.sessionId, foldHome: options.foldHome },
		)
		yield* outputStore.sweep
		const agent = yield* buildAgentDefinition(options, mode, models, cwd, config, outputStore)

		const resumeOptions = {
			agent,
			log: jsonlEventLog(log.path),
			profiles: sessionProfilesFor(models),
			catalog,
			compactionArchiveAccess: compactionArchiveAccessFor({ logPath: log.path, modeName: mode.name }),
		}
		const session = yield* resumeSession(
			options.steering === undefined ? resumeOptions : { ...resumeOptions, steering: options.steering },
		)
		return yield* withGeneratedTitles(
			session,
			models.fast,
			options.foldHome === undefined ? { cwd } : { cwd, foldHome: options.foldHome },
		)
	})

/**
 * Resume the newest session log for the working directory (D5 discovery). The agent is rebuilt fresh -
 * a freshly scanned skills roster and re-read agentfiles - so fold-core's resume path writes one epoch
 * transition iff the configuration changed since the log was written, and nothing when it matches.
 */
export const resumeLatestSession = (
	options?: LaunchSessionOptions,
): Effect.Effect<FoldSession, LaunchModelError | NoSessionToResumeError, Scope.Scope | FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const { options: opts, profileMode } = yield* resolveProfileSelection(options ?? {})
		const mode = modeFor(opts, profileMode)
		const cwd = opts.cwd ?? process.cwd()

		const latest = yield* latestSessionLog(opts.foldHome === undefined ? { cwd } : { cwd, foldHome: opts.foldHome })
		if (latest === null) return yield* new NoSessionToResumeError({ cwd })

		return yield* resumeFromLog(latest, opts, mode, cwd)
	})

/**
 * Resume a specific session id from the current project's session directory. This intentionally stays
 * project-scoped (matching the D5 layout): `sess_*` ids are resolved under `~/.fold/sessions/<slug>/`,
 * not by walking every project directory.
 */
export const resumeSessionById = (
	sessionId: SessionId,
	options?: LaunchSessionOptions,
): Effect.Effect<FoldSession, LaunchModelError | SessionToResumeNotFoundError, Scope.Scope | FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const { options: opts, profileMode } = yield* resolveProfileSelection(options ?? {})
		const mode = modeFor(opts, profileMode)
		const cwd = opts.cwd ?? process.cwd()

		const log = yield* sessionLogById(
			sessionId,
			opts.foldHome === undefined ? { cwd } : { cwd, foldHome: opts.foldHome },
		)
		if (log === null) return yield* new SessionToResumeNotFoundError({ cwd, sessionId })

		return yield* resumeFromLog(log, opts, mode, cwd)
	})
