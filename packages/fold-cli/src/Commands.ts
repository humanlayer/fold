import { spawn } from 'node:child_process'
import { join } from 'node:path'

import {
	configInit,
	configPathFor,
	configureProvider,
	defaultFoldHome,
	ensureManagedBinaries,
	listSessionLogs,
	loadModelCatalog,
	loadFoldConfig,
	FOLD_MODE_NAMES,
	type AutoCompactConfig,
	type LaunchModelError,
	type ManagedBinaryStatus,
	type ModelSelection,
	type NoSessionToResumeError,
	type ConfigureProviderError,
	type SessionToResumeNotFoundError,
	type FoldModeName,
} from '@humanlayer/fold-agent'
import {
	makeCodexAuth,
	makeCodexAuthStore,
	type CodexAuthError,
	type MakeCodexAuthStoreOptions,
} from '@humanlayer/fold-codex'
import { SessionId } from '@humanlayer/fold-core'
import { makeOpenCodeAuth, makeOpenCodeAuthStore, type OpenCodeAuthError } from '@humanlayer/fold-opencode'
import { makeXaiAuth, makeXaiAuthStore, type XaiAuthError } from '@humanlayer/fold-xai'
import { Clock, Console, Effect, Option, Schema } from 'effect'
import { CliError, Command, Flag } from 'effect/unstable/cli'
import { FetchHttpClient } from 'effect/unstable/http'

import { makeJsonOutputRenderer, makeOutputRenderer, type JsonOutputMode } from './Renderer'
import { runPrompt, runReadline, type CliSessionOptions, type ResumeTarget } from './Run'

const version = '0.0.0'

const decodeSessionId = Schema.decodeUnknownOption(SessionId)

/** The sentinel `--resume` value selecting the newest session log for the working directory. */
export const RESUME_LATEST = 'latest'

/** The user supplied a malformed `sess_*` value to `--resume`. */
export class InvalidSessionIdError extends Schema.TaggedErrorClass<InvalidSessionIdError>()('InvalidSessionIdError', {
	value: Schema.String,
}) {}

/** Codex login flow selected by the user; `auto` chooses from terminal/CI context. */
export type CodexLoginFlowChoice = 'auto' | 'browser' | 'device'

/** Concrete Codex login flow to execute. */
export type ResolvedCodexLoginFlow = 'browser' | 'device'

/** Inputs for resolving Codex auth flow flags without touching process globals. */
export type CodexLoginFlowInput = {
	readonly flow: CodexLoginFlowChoice | undefined
	readonly device: boolean
	readonly browser: boolean
	readonly stdinIsTTY: boolean
	readonly stdoutIsTTY: boolean
	readonly isCi: boolean
}

/** Resolve `--flow` plus legacy `--browser`/`--device` flags into the flow the CLI should run. */
export const resolveCodexLoginFlow = (input: CodexLoginFlowInput): ResolvedCodexLoginFlow => {
	if (input.flow === 'browser' || input.flow === 'device') return input.flow
	if (input.flow === undefined && input.browser) return 'browser'
	if (input.flow === undefined && input.device) return 'device'

	return input.stdinIsTTY && input.stdoutIsTTY && !input.isCi ? 'browser' : 'device'
}

/** Whether browser auth should attempt to open the authorization URL automatically. */
export const shouldOpenBrowserForCodexLogin = (input: {
	readonly flow: ResolvedCodexLoginFlow
	readonly noOpen: boolean
	readonly stdoutIsTTY: boolean
}): boolean => input.flow === 'browser' && !input.noOpen && input.stdoutIsTTY

/**
 * Parse a `--resume` value: the `latest` sentinel, or an exact `sess_*` id from the current project.
 * Anything else is a typo, and failing beats silently starting a fresh session (opencode's silent
 * fallback on an unknown id is the anti-pattern here).
 */
export const parseResumeFlag = (raw: string): Effect.Effect<ResumeTarget, InvalidSessionIdError> => {
	const value = raw.trim()
	if (value === RESUME_LATEST) return Effect.succeed({ _tag: 'latest' })

	const decoded = decodeSessionId(value)
	return Option.isSome(decoded)
		? Effect.succeed({ _tag: 'id', sessionId: decoded.value })
		: Effect.fail(new InvalidSessionIdError({ value: raw }))
}

const optionalString = (name: string, description: string) =>
	Flag.string(name).pipe(Flag.withDescription(description), Flag.optional)

const optionalChoice = <const Choices extends ReadonlyArray<string>>(
	name: string,
	choices: Choices,
	description: string,
) => Flag.choice(name, choices).pipe(Flag.withDescription(description), Flag.optional)

const optionalInteger = (name: string, description: string) =>
	Flag.integer(name).pipe(Flag.withDescription(description), Flag.optional)

const codexLoginFlow = optionalChoice(
	'flow',
	['auto', 'browser', 'device'] as const,
	'Codex login flow (auto selects browser for interactive terminals, device for CI/headless)',
)

const commonFlags = {
	prompt: optionalString('prompt', 'Run one non-interactive prompt, then exit'),
	resume: optionalString('resume', 'Resume "latest" or an exact session id from the current project, e.g. sess_...'),
	provider: optionalString('provider', 'Provider profile key from config.providers'),
	model: optionalString('model', 'Provider model id override for the selected role'),
	role: optionalChoice('role', ['smart', 'fast', 'orchestrator'] as const, 'Config role to resolve'),
	profile: optionalString('profile', 'Named profile from config.profiles (a role map, optionally pinning a mode)'),
	mode: optionalChoice(
		'mode',
		FOLD_MODE_NAMES,
		'Agent mode: default (full coding toolset) or rlm (orchestrator that delegates to subagents)',
	),
	rpi: Flag.boolean('rpi').pipe(
		Flag.withDescription('Add the RPI specialist subagents (composable with any --mode)'),
	),
	reasoning: optionalChoice(
		'reasoning',
		['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const,
		'Reasoning level override',
	),
	cwd: optionalString('cwd', 'Project working directory (defaults to process.cwd())'),
	foldHome: Flag.string('fold-home').pipe(
		Flag.withDescription('Fold home directory (defaults to ~/.fold)'),
		Flag.optional,
	),
	noColor: Flag.boolean('no-color').pipe(Flag.withDescription('Disable ANSI colors')),
	verbose: Flag.boolean('verbose').pipe(Flag.withDescription('Stream full tool output/progress')),
	output: optionalChoice(
		'output',
		['human', 'json', 'json-concise', 'json-verbose'] as const,
		'Output format: human (default), json/json-concise (durable log rows), or json-verbose (rows + deltas)',
	),
	outputJson: Flag.boolean('output-json').pipe(
		Flag.withDescription('Alias for --output json (newline-delimited durable log rows on stdout)'),
	),
	autoCompact: Flag.boolean('auto-compact').pipe(Flag.withDescription('Enable auto-compaction for this session')),
	disableAutoCompact: Flag.boolean('disable-auto-compact').pipe(
		Flag.withDescription('Disable auto-compaction even when config enables it'),
	),
	compactionThreshold: optionalInteger('compaction-threshold', 'Context usage in tokens that triggers compaction'),
	compactionReserveTokens: optionalInteger(
		'compaction-reserve-tokens',
		'Reserve this many tokens below the model window when no explicit threshold is set',
	),
	compactionKeepRecentTokens: optionalInteger(
		'compaction-keep-recent-tokens',
		'Keep this many recent tokens verbatim',
	),
	compactionPrompt: optionalString('compaction-prompt', 'Override the compaction summarization prompt'),
}

/** Decoded values of {@link commonFlags}, the root `fold` command's flag set. */
export type CommonFlagValues = {
	readonly prompt: Option.Option<string>
	readonly resume: Option.Option<string>
	readonly provider: Option.Option<string>
	readonly model: Option.Option<string>
	readonly role: Option.Option<'smart' | 'fast' | 'orchestrator'>
	readonly profile: Option.Option<string>
	readonly mode: Option.Option<FoldModeName>
	readonly rpi: boolean
	readonly reasoning: Option.Option<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
	readonly cwd: Option.Option<string>
	readonly foldHome: Option.Option<string>
	readonly noColor: boolean
	readonly verbose: boolean
	readonly output: Option.Option<'human' | 'json' | 'json-concise' | 'json-verbose'>
	readonly outputJson: boolean
	readonly autoCompact: boolean
	readonly disableAutoCompact: boolean
	readonly compactionThreshold: Option.Option<number>
	readonly compactionReserveTokens: Option.Option<number>
	readonly compactionKeepRecentTokens: Option.Option<number>
	readonly compactionPrompt: Option.Option<string>
}

const optionValue = <A>(option: Option.Option<A>): A | undefined => Option.getOrUndefined(option)

const authStorePath = (foldHome: string | undefined): string | undefined =>
	foldHome === undefined ? undefined : join(foldHome, 'auth.json')

const codexProviderId = (provider: Option.Option<string>): string => optionValue(provider) ?? 'codex'

const providerId = (provider: Option.Option<string>, fallback: string): string => optionValue(provider) ?? fallback

const providerAuthStoreOptions = (provider: Option.Option<string>, foldHome: string | undefined, fallback: string) => {
	const path = authStorePath(foldHome)
	return { providerId: providerId(provider, fallback), ...(path === undefined ? {} : { path }) }
}

const codexAuthStoreOptions = (
	provider: Option.Option<string>,
	foldHome: string | undefined,
): MakeCodexAuthStoreOptions => {
	const path = authStorePath(foldHome)
	return { providerId: codexProviderId(provider), ...(path === undefined ? {} : { path }) }
}

const browserOpenCommand = (url: string): { readonly command: string; readonly args: ReadonlyArray<string> } => {
	switch (process.platform) {
		case 'darwin':
			return { command: 'open', args: [url] }
		case 'win32':
			return { command: 'cmd', args: ['/c', 'start', '', url] }
		default:
			return { command: 'xdg-open', args: [url] }
	}
}

const openUrlInBrowser = (url: string): Effect.Effect<boolean> =>
	Effect.try({
		try: () => {
			const { command, args } = browserOpenCommand(url)
			const child = spawn(command, args, { stdio: 'ignore', detached: true })
			child.on('error', () => undefined)
			child.unref()
			return true
		},
		catch: () => false,
	}).pipe(Effect.catch((opened) => Effect.succeed(opened)))

const expiryText = (expires: number): string => new Date(expires).toISOString()

const printAuthUrl = (input: {
	readonly heading: string
	readonly url: string
	readonly noOpen: boolean
	readonly waiting: string
}): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* Console.log(input.heading)
		if (!input.noOpen && process.stdout.isTTY === true) {
			const opened = yield* openUrlInBrowser(input.url)
			yield* Console.log(
				opened
					? 'Opened your browser. If it did not appear, copy the URL below.'
					: 'Could not open your browser automatically; copy the URL below.',
			)
		} else {
			yield* Console.log('Browser auto-open disabled or unavailable; copy the URL below.')
		}
		yield* Console.log(`\n${input.url}\n\n${input.waiting}`)
	})

const modelSelectionFromFlags = (input: {
	readonly role: Option.Option<'smart' | 'fast' | 'orchestrator'>
	readonly provider: Option.Option<string>
	readonly model: Option.Option<string>
	readonly reasoning: Option.Option<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
}): ModelSelection | undefined => {
	const role = optionValue(input.role)
	const provider = optionValue(input.provider)
	const model = optionValue(input.model)
	const reasoning = optionValue(input.reasoning)

	return role === undefined && provider === undefined && model === undefined && reasoning === undefined
		? undefined
		: {
				...(role === undefined ? {} : { role }),
				...(provider === undefined ? {} : { provider }),
				...(model === undefined ? {} : { model }),
				...(reasoning === undefined ? {} : { reasoning }),
			}
}

const autoCompactFromFlags = (input: CommonFlagValues): AutoCompactConfig | undefined => {
	if (input.disableAutoCompact) return { enabled: false }

	const compactionPrompt = optionValue(input.compactionPrompt)
	const thresholdTokens = optionValue(input.compactionThreshold)
	const reserveTokens = optionValue(input.compactionReserveTokens)
	const keepRecentTokens = optionValue(input.compactionKeepRecentTokens)
	const hasCompactionOptions =
		input.autoCompact ||
		compactionPrompt !== undefined ||
		thresholdTokens !== undefined ||
		reserveTokens !== undefined ||
		keepRecentTokens !== undefined

	return hasCompactionOptions
		? {
				enabled: true,
				...(compactionPrompt === undefined ? {} : { compactionPrompt }),
				...(thresholdTokens === undefined ? {} : { thresholdTokens }),
				...(reserveTokens === undefined ? {} : { reserveTokens }),
				...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
			}
		: undefined
}

/** CLI rendering mode selected by `--output*` flags. */
export type CliOutputMode = 'human' | JsonOutputMode

/** Lower output flags. `--output json` is intentionally the concise JSONL mode. */
export const outputModeFromFlags = (input: {
	readonly output: Option.Option<'human' | 'json' | 'json-concise' | 'json-verbose'>
	readonly outputJson: boolean
}): CliOutputMode => {
	const output = optionValue(input.output)
	if (output === 'human') return 'human'
	if (output === 'json-verbose') return 'json-verbose'
	if (output === 'json' || output === 'json-concise') return 'json-concise'

	return input.outputJson ? 'json-concise' : 'human'
}

/** Lower the root command's flags into the session options `runPrompt`/`runReadline` consume. */
export const sessionOptionsFromFlags = (
	input: CommonFlagValues,
): Effect.Effect<CliSessionOptions, InvalidSessionIdError> =>
	Effect.gen(function* () {
		const rawResume = optionValue(input.resume)
		const resume = rawResume === undefined ? undefined : yield* parseResumeFlag(rawResume)
		const foldHome = optionValue(input.foldHome)
		const profile = optionValue(input.profile)
		const mode = optionValue(input.mode)
		const modelSelection = modelSelectionFromFlags(input)
		const autoCompact = autoCompactFromFlags(input)

		return {
			cwd: optionValue(input.cwd) ?? process.cwd(),
			...(foldHome === undefined ? {} : { foldHome }),
			...(profile === undefined ? {} : { profile }),
			...(mode === undefined ? {} : { mode }),
			...(input.rpi ? { rpi: true } : {}),
			...(resume === undefined ? {} : { resume }),
			...(modelSelection === undefined ? {} : { modelSelection }),
			...(autoCompact === undefined ? {} : { autoCompact }),
		}
	})

const run = Command.make('foldcode', commonFlags, (input) =>
	Effect.scoped(
		Effect.gen(function* () {
			const flagOptions = yield* sessionOptionsFromFlags(input)
			// One catalog load per invocation (never fails - degrades to cache/baked data): the launch
			// consumes it for validation + compaction windows, the renderer for Cost/Context columns.
			const catalog = yield* loadModelCatalog({
				foldHome: flagOptions.foldHome ?? defaultFoldHome(),
				env: (name) => process.env[name],
			})
			const sessionOptions = { ...flagOptions, catalog }
			const outputMode = outputModeFromFlags(input)
			const renderer =
				outputMode === 'human'
					? makeOutputRenderer({ colors: !input.noColor, verbose: input.verbose, catalog })
					: makeJsonOutputRenderer({ mode: outputMode })
			const prompt = optionValue(input.prompt)

			if (prompt === undefined) {
				yield* runReadline(sessionOptions, renderer)
				return
			}

			const finished = yield* runPrompt({ ...sessionOptions, prompt }, renderer)
			if (finished.outcome === 'completed') return

			process.exitCode = finished.outcome === 'interrupted' ? 130 : 1
		}),
	),
).pipe(
	Command.withDescription('Run the fold headless coding agent'),
	Command.withExamples([
		{ command: 'foldcode --prompt "fix the lint failure"', description: 'Run one CI-friendly prompt' },
		{ command: 'foldcode --resume latest', description: 'Resume the newest session in this project' },
		{
			command: 'foldcode --resume sess_abc123 --model claude-sonnet-4-5',
			description: 'Resume by id in this project',
		},
	]),
)

const binStatusLine = (status: ManagedBinaryStatus): string =>
	`${status.name}\t${status.resolution}\t${status.path ?? status.detail ?? ''}`

const bin = Command.make('bin').pipe(
	Command.withDescription('Manage the external binaries fold provides to agents (rg, fd, ast-grep)'),
	Command.withSubcommands([
		Command.make('status', { foldHome: commonFlags.foldHome }, (input) =>
			Effect.gen(function* () {
				const foldHome = optionValue(input.foldHome) ?? defaultFoldHome()
				const statuses = yield* ensureManagedBinaries({ foldHome, disableDownloads: true, memoize: false })
				for (const status of statuses) yield* Console.log(binStatusLine(status))
			}),
		).pipe(Command.withDescription('Show how each managed binary resolves (never downloads)')),
		Command.make('install', { foldHome: commonFlags.foldHome }, (input) =>
			Effect.gen(function* () {
				const foldHome = optionValue(input.foldHome) ?? defaultFoldHome()
				const statuses = yield* ensureManagedBinaries({ foldHome, requireManagedInstall: true, memoize: false })
				for (const status of statuses) yield* Console.log(binStatusLine(status))
			}),
		).pipe(Command.withDescription('Install any missing managed binaries into <foldHome>/bin')),
	]),
)

const sessions = Command.make(
	'sessions',
	{
		cwd: commonFlags.cwd,
		foldHome: commonFlags.foldHome,
	},
	(input) =>
		Effect.gen(function* () {
			const cwd = optionValue(input.cwd) ?? process.cwd()
			const foldHome = optionValue(input.foldHome)
			const sessions = yield* listSessionLogs({ cwd, ...(foldHome === undefined ? {} : { foldHome }) })
			if (sessions.length === 0) {
				yield* Console.log(`No fold sessions for ${cwd}`)
				return
			}

			for (const session of sessions) {
				yield* Console.log(`${session.sessionId}\t${new Date(session.mtimeMs).toISOString()}\t${session.path}`)
			}
		}),
).pipe(Command.withDescription('List sessions for the current project'))

const tui = Command.make('tui', commonFlags, (input) =>
	Effect.scoped(
		Effect.gen(function* () {
			const options = yield* sessionOptionsFromFlags(input)
			const catalog = yield* loadModelCatalog({
				foldHome: options.foldHome ?? defaultFoldHome(),
				env: (name) => process.env[name],
			})
			const prompt = optionValue(input.prompt)
			yield* Effect.promise(() => import('@opentui/solid/preload'))
			const module = yield* Effect.promise(() => import('./tui/Shell'))
			yield* module.runTui({ ...options, catalog, ...(prompt === undefined ? {} : { prompt }) }).pipe(
				Effect.catchTags({
					TuiRequiresTtyError: () =>
						printFailure(
							'foldcode tui requires an interactive TTY; use foldcode --prompt "..." --output json instead',
						),
					TuiRendererError: (error: { readonly message: string }) =>
						printFailure(`could not start the TUI: ${error.message}`),
				}),
			)
		}),
	),
).pipe(Command.withDescription('Run the interactive TACTICAL terminal UI'))

const config = Command.make('config').pipe(
	Command.withDescription('Manage fold configuration'),
	Command.withSubcommands([
		Command.make('provider').pipe(
			Command.withDescription('Add or update provider connections'),
			Command.withSubcommands([
				Command.make(
					'add',
					{
						name: Flag.string('name').pipe(
							Flag.withDescription('Provider profile name used by --provider'),
						),
						kind: Flag.choice('kind', ['anthropic', 'openai-compat'] as const).pipe(
							Flag.withDescription('Compatible API protocol'),
						),
						baseUrl: Flag.string('base-url').pipe(Flag.withDescription('Provider API base URL')),
						apiKey: optionalString(
							'api-key',
							'Inline API key (visible in process arguments; prefer --api-key-env)',
						),
						apiKeyEnv: optionalString('api-key-env', 'Environment variable name containing the API key'),
						model: optionalString('model', 'Optional model ID to expose in the TUI model picker'),
						foldHome: commonFlags.foldHome,
					},
					(input) =>
						Effect.gen(function* () {
							const apiKey = optionValue(input.apiKey)
							const apiKeyEnv = optionValue(input.apiKeyEnv)
							const model = optionValue(input.model)
							const foldHome = optionValue(input.foldHome)
							yield* configureProvider(
								{
									name: input.name,
									kind: input.kind,
									baseUrl: input.baseUrl,
									...(apiKey === undefined ? {} : { apiKey }),
									...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
									...(model === undefined ? {} : { model }),
								},
								foldHome === undefined ? {} : { foldHome },
							)
							yield* Console.log(
								`Saved provider "${input.name}" in ${configPathFor(foldHome === undefined ? {} : { foldHome })}`,
							)
						}),
				).pipe(
					Command.withDescription('Add or replace an Anthropic/OpenAI-compatible URL and credential'),
					Command.withExamples([
						{
							command:
								'foldcode config provider add --name openrouter --kind openai-compat --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY --model anthropic/claude-sonnet-4',
							description: 'Add an OpenAI-compatible provider using an environment variable',
						},
					]),
				),
			]),
		),
		Command.make('init', { foldHome: commonFlags.foldHome }, (input) =>
			Effect.gen(function* () {
				const foldHome = optionValue(input.foldHome)
				const result = yield* configInit(foldHome === undefined ? {} : { foldHome })
				yield* Console.log(`${result.createdConfig ? 'Created' : 'Found'} ${result.configPath}`)
				yield* Console.log(`${result.createdAuth ? 'Created' : 'Found'} ${result.authPath}`)
				yield* Console.log(`Wrote ${result.schemaPath}`)
				yield* Console.log(`Wrote ${result.infoPath}`)
			}),
		).pipe(Command.withDescription('Create ~/.fold/config.jsonc and config.schema.json')),
		Command.make('validate', { foldHome: commonFlags.foldHome }, (input) =>
			Effect.gen(function* () {
				const foldHome = optionValue(input.foldHome)
				yield* loadFoldConfig(foldHome === undefined ? {} : { foldHome })
				yield* Console.log(`Valid ${configPathFor(foldHome === undefined ? {} : { foldHome })}`)
			}),
		).pipe(Command.withDescription('Validate ~/.fold/config.jsonc')),
	]),
)

type ProviderAuthInput = {
	readonly provider: Option.Option<string>
	readonly foldHome: Option.Option<string>
}

type ProviderLoginInput = ProviderAuthInput & { readonly noOpen: boolean }

const openCodeLogin = (input: ProviderLoginInput) =>
	Effect.gen(function* () {
		const foldHome = optionValue(input.foldHome)
		const store = makeOpenCodeAuthStore(providerAuthStoreOptions(input.provider, foldHome, 'opencode'))
		const openCodeAuth = yield* makeOpenCodeAuth({
			store,
			onDeviceCode: (prompt) =>
				printAuthUrl({
					heading: `OpenCode device login\n\nCode: ${prompt.userCode}`,
					url: prompt.url,
					noOpen: input.noOpen,
					waiting: 'Waiting for approval...',
				}),
		}).pipe(Effect.provide(FetchHttpClient.layer))
		yield* Console.log(
			`Using OpenCode device authentication for provider "${providerId(input.provider, 'opencode')}"`,
		)
		const token = yield* openCodeAuth.authenticateDevice
		const identity = token.metadata
			? ` for ${token.metadata.email}${token.metadata.orgName === undefined ? '' : ` (${token.metadata.orgName})`}`
			: ''
		yield* Console.log(
			`Saved OpenCode credential${identity} to ${store.path} (expires ${expiryText(token.expires)})`,
		)
	})

const openCodeCommands = Command.make('opencode').pipe(
	Command.withDescription('Manage OpenCode OAuth credentials'),
	Command.withSubcommands([
		Command.make(
			'login',
			{
				provider: commonFlags.provider,
				foldHome: commonFlags.foldHome,
				noOpen: Flag.boolean('no-open').pipe(
					Flag.withDescription('Print the device authorization URL without opening it'),
				),
			},
			openCodeLogin,
		).pipe(Command.withDescription('Authenticate OpenCode using its device flow')),
		Command.make(
			'device',
			{
				provider: commonFlags.provider,
				foldHome: commonFlags.foldHome,
				noOpen: Flag.boolean('no-open').pipe(
					Flag.withDescription('Print the device authorization URL without opening it'),
				),
			},
			openCodeLogin,
		).pipe(Command.withDescription('Authenticate OpenCode using its device flow')),
		Command.make('browser', { provider: commonFlags.provider, foldHome: commonFlags.foldHome }, (input) =>
			printFailure(
				`OpenCode does not support browser OAuth for provider "${providerId(input.provider, 'opencode')}"; use foldcode auth opencode device`,
			),
		).pipe(Command.withDescription('Report that OpenCode browser authentication is unsupported')),
		Command.make('status', { provider: commonFlags.provider, foldHome: commonFlags.foldHome }, (input) =>
			Effect.gen(function* () {
				const store = makeOpenCodeAuthStore(
					providerAuthStoreOptions(input.provider, optionValue(input.foldHome), 'opencode'),
				)
				const token = yield* store.load
				if (Option.isNone(token)) {
					yield* Console.log(
						`No OpenCode credential found in ${store.path}. Run foldcode auth opencode login.`,
					)
					return
				}
				const now = yield* Clock.currentTimeMillis
				const identity = token.value.metadata
					? ` for ${token.value.metadata.email}${token.value.metadata.orgName === undefined ? '' : ` (${token.value.metadata.orgName})`}`
					: ''
				yield* Console.log(
					`OpenCode credential ${token.value.isExpired(now) ? 'expired' : 'valid'}${identity} in ${store.path} (expires ${expiryText(token.value.expires)})`,
				)
			}),
		).pipe(Command.withDescription('Show the stored OpenCode credential status')),
		Command.make('logout', { provider: commonFlags.provider, foldHome: commonFlags.foldHome }, (input) =>
			Effect.gen(function* () {
				const store = makeOpenCodeAuthStore(
					providerAuthStoreOptions(input.provider, optionValue(input.foldHome), 'opencode'),
				)
				const service = yield* makeOpenCodeAuth({ store }).pipe(Effect.provide(FetchHttpClient.layer))
				yield* service.logout
				yield* Console.log(`Removed OpenCode credential from ${store.path}`)
			}),
		).pipe(Command.withDescription('Remove the stored OpenCode credential')),
	]),
)

const xaiLogin = (flow: ResolvedCodexLoginFlow, input: ProviderLoginInput) =>
	Effect.gen(function* () {
		const store = makeXaiAuthStore(providerAuthStoreOptions(input.provider, optionValue(input.foldHome), 'xai'))
		const xaiAuth = yield* makeXaiAuth({
			store,
			onDeviceCode: (prompt) =>
				printAuthUrl({
					heading: `xAI device login\n\nCode: ${prompt.userCode}`,
					url: prompt.browserUrl,
					noOpen: input.noOpen,
					waiting: 'Waiting for approval...',
				}),
			onBrowserUrl: (url) =>
				printAuthUrl({
					heading: 'xAI browser login',
					url,
					noOpen: input.noOpen,
					waiting: 'Waiting for browser callback on localhost...',
				}),
		}).pipe(Effect.provide(FetchHttpClient.layer))
		yield* Console.log(`Using xAI ${flow} authentication for provider "${providerId(input.provider, 'xai')}"`)
		const token = yield* flow === 'browser' ? xaiAuth.authenticateBrowser : xaiAuth.authenticateDevice
		yield* Console.log(
			`Saved xAI credential${token.accountId === undefined ? '' : ` for account ${token.accountId}`} to ${store.path} (expires ${expiryText(token.expires)})`,
		)
	})

const xaiExplicitLoginCommand = (name: ResolvedCodexLoginFlow) =>
	Command.make(
		name,
		{
			provider: commonFlags.provider,
			foldHome: commonFlags.foldHome,
			noOpen: Flag.boolean('no-open').pipe(
				Flag.withDescription('Print the authorization URL without opening it'),
			),
		},
		(input) => xaiLogin(name, input),
	).pipe(Command.withDescription(`Authenticate xAI using the ${name} flow`))

const xaiCommands = Command.make('xai').pipe(
	Command.withDescription('Manage xAI OAuth credentials'),
	Command.withSubcommands([
		Command.make(
			'login',
			{
				provider: commonFlags.provider,
				foldHome: commonFlags.foldHome,
				noOpen: Flag.boolean('no-open').pipe(
					Flag.withDescription('Print the authorization URL without opening it'),
				),
			},
			(input) =>
				xaiLogin(
					resolveCodexLoginFlow({
						flow: undefined,
						device: false,
						browser: false,
						stdinIsTTY: process.stdin.isTTY === true,
						stdoutIsTTY: process.stdout.isTTY === true,
						isCi: process.env.CI !== undefined,
					}),
					input,
				),
		).pipe(Command.withDescription('Authenticate xAI (browser interactively, device in CI/headless environments)')),
		xaiExplicitLoginCommand('browser'),
		xaiExplicitLoginCommand('device'),
		Command.make('status', { provider: commonFlags.provider, foldHome: commonFlags.foldHome }, (input) =>
			Effect.gen(function* () {
				const store = makeXaiAuthStore(
					providerAuthStoreOptions(input.provider, optionValue(input.foldHome), 'xai'),
				)
				const token = yield* store.load
				if (Option.isNone(token)) {
					yield* Console.log(`No xAI credential found in ${store.path}. Run foldcode auth xai login.`)
					return
				}
				const now = yield* Clock.currentTimeMillis
				yield* Console.log(
					`xAI credential ${token.value.isExpired(now) ? 'expired' : 'valid'}${token.value.accountId === undefined ? '' : ` for account ${token.value.accountId}`} in ${store.path} (expires ${expiryText(token.value.expires)})`,
				)
			}),
		).pipe(Command.withDescription('Show the stored xAI credential status')),
		Command.make('logout', { provider: commonFlags.provider, foldHome: commonFlags.foldHome }, (input) =>
			Effect.gen(function* () {
				const store = makeXaiAuthStore(
					providerAuthStoreOptions(input.provider, optionValue(input.foldHome), 'xai'),
				)
				const service = yield* makeXaiAuth({ store }).pipe(Effect.provide(FetchHttpClient.layer))
				yield* service.logout
				yield* Console.log(`Removed xAI credential from ${store.path}`)
			}),
		).pipe(Command.withDescription('Remove the stored xAI credential')),
	]),
)

const auth = Command.make('auth').pipe(
	Command.withDescription('Manage provider authentication'),
	Command.withSubcommands([
		openCodeCommands,
		xaiCommands,
		Command.make('codex').pipe(
			Command.withDescription('Manage Codex OAuth credentials'),
			Command.withSubcommands([
				Command.make(
					'login',
					{
						provider: commonFlags.provider,
						foldHome: commonFlags.foldHome,
						flow: codexLoginFlow,
						device: Flag.boolean('device').pipe(
							Flag.withDescription('Use the headless device-code flow (legacy alias for --flow device)'),
						),
						browser: Flag.boolean('browser').pipe(
							Flag.withDescription(
								'Use the loopback browser PKCE flow (legacy alias for --flow browser)',
							),
						),
						noOpen: Flag.boolean('no-open').pipe(
							Flag.withDescription('Print the browser authorization URL without opening it'),
						),
					},
					(input) =>
						Effect.gen(function* () {
							const foldHome = optionValue(input.foldHome)
							const selectedFlow = resolveCodexLoginFlow({
								flow: optionValue(input.flow),
								device: input.device,
								browser: input.browser,
								stdinIsTTY: process.stdin.isTTY === true,
								stdoutIsTTY: process.stdout.isTTY === true,
								isCi: process.env.CI !== undefined,
							})
							const shouldOpen = shouldOpenBrowserForCodexLogin({
								flow: selectedFlow,
								noOpen: input.noOpen,
								stdoutIsTTY: process.stdout.isTTY === true,
							})
							const store = makeCodexAuthStore(codexAuthStoreOptions(input.provider, foldHome))
							const codexAuth = yield* makeCodexAuth({
								store,
								onDeviceCode: (prompt) =>
									Console.log(
										`Codex device login\n\nOpen: ${prompt.verifyUrl}\nCode: ${prompt.userCode}\n\nWaiting for approval...`,
									),
								onBrowserUrl: (url) =>
									Effect.gen(function* () {
										yield* Console.log('Codex browser login')
										if (shouldOpen) {
											const opened = yield* openUrlInBrowser(url)
											yield* Console.log(
												opened
													? 'Opened your browser. If it did not appear, copy the URL below.'
													: 'Could not open your browser automatically; copy the URL below.',
											)
										} else {
											yield* Console.log(
												'Browser auto-open disabled or unavailable; copy the URL below.',
											)
										}
										yield* Console.log(`\n${url}\n\nWaiting for browser callback on localhost...`)
									}),
							}).pipe(Effect.provide(FetchHttpClient.layer))
							yield* Console.log(
								`Using Codex ${selectedFlow} authentication for provider "${codexProviderId(input.provider)}"`,
							)
							const token = yield* selectedFlow === 'device'
								? codexAuth.authenticateDevice
								: codexAuth.authenticateBrowser

							yield* Console.log(
								`Saved Codex credential${token.accountId === undefined ? '' : ` for account ${token.accountId}`} to ${store.path} (expires ${expiryText(token.expires)})`,
							)
						}),
				).pipe(Command.withDescription('Authenticate Codex and persist the OAuth credential')),
				Command.make(
					'status',
					{
						provider: commonFlags.provider,
						foldHome: commonFlags.foldHome,
						refresh: Flag.boolean('refresh').pipe(
							Flag.withDescription('Refresh an expired credential and persist the repaired token'),
						),
					},
					(input) =>
						Effect.gen(function* () {
							const foldHome = optionValue(input.foldHome)
							const store = makeCodexAuthStore(codexAuthStoreOptions(input.provider, foldHome))
							if (input.refresh) {
								const codexAuth = yield* makeCodexAuth({ store }).pipe(
									Effect.provide(FetchHttpClient.layer),
								)
								const token = yield* codexAuth.get
								yield* Console.log(
									`Codex credential valid${token.accountId === undefined ? '' : ` for account ${token.accountId}`} in ${store.path} (expires ${expiryText(token.expires)})`,
								)
								return
							}

							const token = yield* store.load
							if (Option.isNone(token)) {
								yield* Console.log(
									`No Codex credential found in ${store.path}. Run foldcode auth codex login.`,
								)
								return
							}

							const now = yield* Clock.currentTimeMillis
							const expiry = token.value.isExpired(now) ? 'expired' : 'valid'
							yield* Console.log(
								`Codex credential ${expiry}${
									token.value.accountId === undefined ? '' : ` for account ${token.value.accountId}`
								} in ${store.path} (expires ${expiryText(token.value.expires)})${
									token.value.isExpired(now)
										? '; run foldcode auth codex status --refresh to refresh now, or foldcode auth codex login to reauthenticate'
										: ''
								}`,
							)
						}),
				).pipe(Command.withDescription('Show the stored Codex credential status')),
				Command.make('logout', { provider: commonFlags.provider, foldHome: commonFlags.foldHome }, (input) =>
					Effect.gen(function* () {
						const foldHome = optionValue(input.foldHome)
						const store = makeCodexAuthStore(codexAuthStoreOptions(input.provider, foldHome))
						const codexAuth = yield* makeCodexAuth({ store }).pipe(Effect.provide(FetchHttpClient.layer))
						yield* codexAuth.logout
						yield* Console.log(`Removed Codex credential from ${store.path}`)
					}),
				).pipe(Command.withDescription('Remove the stored Codex credential')),
			]),
		),
	]),
)

const printFailure = (message: string): Effect.Effect<void> =>
	Console.error(`error: ${message}`).pipe(
		Effect.andThen(
			Effect.sync(() => {
				process.exitCode = 1
			}),
		),
	)

type CliCommandError =
	| InvalidSessionIdError
	| CodexAuthError
	| OpenCodeAuthError
	| XaiAuthError
	| ConfigureProviderError
	| LaunchModelError
	| NoSessionToResumeError
	| SessionToResumeNotFoundError
	| CliError.CliError

const withErrorHandling = <R>(effect: Effect.Effect<void, CliCommandError, R>): Effect.Effect<void, never, R> =>
	effect.pipe(
		Effect.catchTags({
			UnrecognizedOption: (error) => printFailure(error.message),
			DuplicateOption: (error) => printFailure(error.message),
			MissingOption: (error) => printFailure(error.message),
			MissingArgument: (error) => printFailure(error.message),
			InvalidValue: (error) => printFailure(error.message),
			UnknownSubcommand: (error) => printFailure(error.message),
			UserError: (error) => printFailure(error.message),
			ShowHelp: (error) =>
				Effect.sync(() => {
					process.exitCode = error.errors.length === 0 ? 0 : 1
				}),
			InvalidSessionIdError: (error: InvalidSessionIdError) =>
				printFailure(`invalid --resume value "${error.value}"; pass "latest" or an exact sess_... id`),
			ConfigFileNotFoundError: (error) =>
				printFailure(
					`config not found at ${error.path}; run foldcode config init or configure ~/.fold/config.jsonc`,
				),
			ConfigParseError: (error) =>
				printFailure(`could not parse config${error.path === null ? '' : ` ${error.path}`}: ${error.message}`),
			ConfigDecodeError: (error) =>
				printFailure(`config shape is invalid${error.path === null ? '' : ` ${error.path}`}: ${error.message}`),
			RoleResolutionError: (error) => printFailure(error.message),
			UnknownProfileError: (error) =>
				printFailure(
					`unknown profile "${error.profile}"; available: ${error.available.length === 0 ? '(none configured)' : error.available.join(', ')}`,
				),
			NoSessionToResumeError: (error) => printFailure(`no fold sessions exist for ${error.cwd}`),
			SessionToResumeNotFoundError: (error) =>
				printFailure(`session ${error.sessionId} was not found for ${error.cwd}`),
			CodexAuthError: (error) => printFailure(error.message),
			OpenCodeAuthError: (error) => printFailure(error.message),
			XaiAuthError: (error) => printFailure(error.message),
			ProviderConfigurationValidationError: (error) => printFailure(error.message),
			ProviderConfigurationKindError: (error) => printFailure(error.message),
			ProviderConfigurationWriteError: (error) => printFailure(error.message),
		}),
	)

/** Effect CLI command tree for the installed `fold` binary. */
export const command = run.pipe(Command.withSubcommands([tui, sessions, config, auth, bin]))

/** Main Effect for the installed CLI binary. */
export const main = withErrorHandling(command.pipe(Command.run({ version })))
