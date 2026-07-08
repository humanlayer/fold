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
 */
import {
	defineAgent,
	resumeSession,
	startSession,
	type AgentDefinition,
	type AutoCompactConfig,
	type SteeringMode,
	type TartModel,
	type TartSession,
	type TartTool,
} from '@humanlayer/tart-core'
import { Effect, Schema, type Scope } from 'effect'

import { agentModelsFromConfig, type EnvLookup, type RoleResolutionError } from '../Config/AgentModels'
import type { TartConfig } from '../Config/ConfigSchema'
import {
	loadTartConfig,
	type ConfigDecodeError,
	type ConfigFileNotFoundError,
	type ConfigParseError,
} from '../Config/Load'
import { jsonlEventLog } from '../EventLog/JsonlDescriptor'
import { memoryPromptBlock } from '../Memory/AgentFiles'
import { latestSessionLog, prepareSessionLog } from '../Session/SessionLayout'
import { defaultCodingMode, type TartMode } from './Mode'

/** Failures resolving the primary model for a launch (config load + role resolution). */
export type LaunchModelError = ConfigFileNotFoundError | ConfigParseError | ConfigDecodeError | RoleResolutionError

/** No session log exists for the working directory to resume. */
export class NoSessionToResumeError extends Schema.TaggedErrorClass<NoSessionToResumeError>()(
	'NoSessionToResumeError',
	{
		cwd: Schema.String,
	},
) {}

/** Shared launch/resume inputs. */
export type LaunchSessionOptions = {
	/** The mode to run. Defaults to {@link defaultCodingMode}. */
	readonly mode?: TartMode
	/** An already-decoded config. When omitted, the config is loaded from `<tartHome>/config.jsonc`. */
	readonly config?: TartConfig
	/** An explicit model, bypassing config/role resolution entirely (no config file needed). */
	readonly model?: TartModel
	/** The project working directory. Defaults to `process.cwd()`. */
	readonly cwd?: string
	/** The tart home directory (config, sessions). Defaults to `~/.tart`. */
	readonly tartHome?: string
	/** Home directory for the agentfile global chain. Defaults to `os.homedir()`. */
	readonly home?: string
	/** Environment lookup for provider `apiKeyEnv`. Defaults to reading `process.env`. */
	readonly env?: EnvLookup
	/** Auto-compaction policy (D11). Omitted means disabled. */
	readonly autoCompact?: AutoCompactConfig
	/** Steering drain mode (D8). Defaults to one-at-a-time. */
	readonly steering?: SteeringMode
	/** Extra tools appended after the mode's roster (e.g. subagents). */
	readonly extraTools?: ReadonlyArray<TartTool>
	/** Agent display name recorded in `session_started`. Defaults to the mode name. */
	readonly name?: string
}

/** Resolve the primary model: explicit override, else the config role for the mode. */
const resolvePrimaryModel = (
	options: LaunchSessionOptions,
	mode: TartMode,
): Effect.Effect<TartModel, LaunchModelError> =>
	Effect.gen(function* () {
		if (options.model !== undefined) return options.model

		const config =
			options.config ??
			(yield* loadTartConfig(options.tartHome === undefined ? {} : { tartHome: options.tartHome }))
		const models = agentModelsFromConfig(config, options.env === undefined ? {} : { env: options.env })
		return yield* models.resolve(mode.role)
	})

/** Assemble the agent definition: mode prompt + agentfiles as leading blocks, mode + extra tools. */
const buildAgentDefinition = (
	options: LaunchSessionOptions,
	mode: TartMode,
	model: TartModel,
	cwd: string,
): Effect.Effect<AgentDefinition> =>
	Effect.gen(function* () {
		const memoryBlock = yield* memoryPromptBlock({
			cwd,
			...(options.home === undefined ? {} : { home: options.home }),
		})
		const tools = [...mode.buildTools({ cwd }), ...(options.extraTools ?? [])]
		const blocks = [
			...(mode.systemPrompt === undefined ? [] : [mode.systemPrompt]),
			...(memoryBlock === null ? [] : [memoryBlock]),
		]

		return defineAgent({
			name: options.name ?? mode.name,
			model,
			tools,
			...(blocks.length === 0 ? {} : { systemPrompt: blocks }),
			...(options.autoCompact === undefined ? {} : { autoCompact: options.autoCompact }),
		})
	})

/**
 * Start a fresh coding session: resolve the model, load agentfiles, build the mode's tools, and
 * `startSession` over a JSONL log named by a freshly minted session id under the D5 layout.
 */
export const launchSession = (
	options?: LaunchSessionOptions,
): Effect.Effect<TartSession, LaunchModelError, Scope.Scope> =>
	Effect.gen(function* () {
		const opts = options ?? {}
		const mode = opts.mode ?? defaultCodingMode
		const cwd = opts.cwd ?? process.cwd()

		const model = yield* resolvePrimaryModel(opts, mode)
		const agent = yield* buildAgentDefinition(opts, mode, model, cwd)

		const prepared = yield* prepareSessionLog({
			cwd,
			...(opts.tartHome === undefined ? {} : { tartHome: opts.tartHome }),
		})

		return yield* startSession({
			agent,
			log: prepared.log,
			cwd,
			sessionId: prepared.sessionId,
			...(opts.steering === undefined ? {} : { steering: opts.steering }),
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
		const opts = options ?? {}
		const mode = opts.mode ?? defaultCodingMode
		const cwd = opts.cwd ?? process.cwd()

		const latest = yield* latestSessionLog({
			cwd,
			...(opts.tartHome === undefined ? {} : { tartHome: opts.tartHome }),
		})
		if (latest === null) return yield* new NoSessionToResumeError({ cwd })

		const model = yield* resolvePrimaryModel(opts, mode)
		const agent = yield* buildAgentDefinition(opts, mode, model, cwd)

		return yield* resumeSession({
			agent,
			log: jsonlEventLog(latest.path),
			...(opts.steering === undefined ? {} : { steering: opts.steering }),
		})
	})
