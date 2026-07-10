import { spawn } from 'node:child_process'
import { join } from 'node:path'

import {
	configInit,
	configPathFor,
	defaultTartHome,
	listSessionLogs,
	loadModelCatalog,
	loadTartConfig,
	TART_MODE_NAMES,
	type AutoCompactConfig,
	type LaunchModelError,
	type ModelSelection,
	type NoSessionToResumeError,
	type SessionToResumeNotFoundError,
	type TartModeName,
} from '@humanlayer/tart-agent'
import {
	makeCodexAuth,
	makeCodexAuthStore,
	type CodexAuthError,
	type MakeCodexAuthStoreOptions,
} from '@humanlayer/tart-codex'
import { SessionId } from '@humanlayer/tart-core'
import { Clock, Console, Effect, Option, Schema } from 'effect'
import { CliError, Command, Flag } from 'effect/unstable/cli'
import { FetchHttpClient } from 'effect/unstable/http'

import { makeOutputRenderer } from './Renderer'
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
	mode: optionalChoice(
		'mode',
		TART_MODE_NAMES,
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
	tartHome: Flag.string('tart-home').pipe(
		Flag.withDescription('Tart home directory (defaults to ~/.tart)'),
		Flag.optional,
	),
	noColor: Flag.boolean('no-color').pipe(Flag.withDescription('Disable ANSI colors')),
	verbose: Flag.boolean('verbose').pipe(Flag.withDescription('Stream full tool output/progress')),
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

/** Decoded values of {@link commonFlags}, the root `tart` command's flag set. */
export type CommonFlagValues = {
	readonly prompt: Option.Option<string>
	readonly resume: Option.Option<string>
	readonly provider: Option.Option<string>
	readonly model: Option.Option<string>
	readonly role: Option.Option<'smart' | 'fast' | 'orchestrator'>
	readonly mode: Option.Option<TartModeName>
	readonly rpi: boolean
	readonly reasoning: Option.Option<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
	readonly cwd: Option.Option<string>
	readonly tartHome: Option.Option<string>
	readonly noColor: boolean
	readonly verbose: boolean
	readonly autoCompact: boolean
	readonly disableAutoCompact: boolean
	readonly compactionThreshold: Option.Option<number>
	readonly compactionReserveTokens: Option.Option<number>
	readonly compactionKeepRecentTokens: Option.Option<number>
	readonly compactionPrompt: Option.Option<string>
}

const optionValue = <A>(option: Option.Option<A>): A | undefined => Option.getOrUndefined(option)

const authStorePath = (tartHome: string | undefined): string | undefined =>
	tartHome === undefined ? undefined : join(tartHome, 'auth.json')

const codexProviderId = (provider: Option.Option<string>): string => optionValue(provider) ?? 'codex'

const codexAuthStoreOptions = (
	provider: Option.Option<string>,
	tartHome: string | undefined,
): MakeCodexAuthStoreOptions => {
	const path = authStorePath(tartHome)
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

/** Lower the root command's flags into the session options `runPrompt`/`runReadline` consume. */
export const sessionOptionsFromFlags = (
	input: CommonFlagValues,
): Effect.Effect<CliSessionOptions, InvalidSessionIdError> =>
	Effect.gen(function* () {
		const rawResume = optionValue(input.resume)
		const resume = rawResume === undefined ? undefined : yield* parseResumeFlag(rawResume)
		const tartHome = optionValue(input.tartHome)
		const mode = optionValue(input.mode)
		const modelSelection = modelSelectionFromFlags(input)
		const autoCompact = autoCompactFromFlags(input)

		return {
			cwd: optionValue(input.cwd) ?? process.cwd(),
			...(tartHome === undefined ? {} : { tartHome }),
			...(mode === undefined ? {} : { mode }),
			...(input.rpi ? { rpi: true } : {}),
			...(resume === undefined ? {} : { resume }),
			...(modelSelection === undefined ? {} : { modelSelection }),
			...(autoCompact === undefined ? {} : { autoCompact }),
		}
	})

const run = Command.make('tart', commonFlags, (input) =>
	Effect.scoped(
		Effect.gen(function* () {
			const flagOptions = yield* sessionOptionsFromFlags(input)
			// One catalog load per invocation (never fails - degrades to cache/baked data): the launch
			// consumes it for validation + compaction windows, the renderer for Cost/Context columns.
			const catalog = yield* loadModelCatalog({
				tartHome: flagOptions.tartHome ?? defaultTartHome(),
				env: (name) => process.env[name],
			})
			const sessionOptions = { ...flagOptions, catalog }
			const renderer = makeOutputRenderer({ colors: !input.noColor, verbose: input.verbose, catalog })
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
	Command.withDescription('Run the tart headless coding agent'),
	Command.withExamples([
		{ command: 'tart --prompt "fix the lint failure"', description: 'Run one CI-friendly prompt' },
		{ command: 'tart --resume latest', description: 'Resume the newest session in this project' },
		{ command: 'tart --resume sess_abc123 --model claude-sonnet-4-5', description: 'Resume by id in this project' },
	]),
)

const sessions = Command.make(
	'sessions',
	{
		cwd: commonFlags.cwd,
		tartHome: commonFlags.tartHome,
	},
	(input) =>
		Effect.gen(function* () {
			const cwd = optionValue(input.cwd) ?? process.cwd()
			const tartHome = optionValue(input.tartHome)
			const sessions = yield* listSessionLogs({ cwd, ...(tartHome === undefined ? {} : { tartHome }) })
			if (sessions.length === 0) {
				yield* Console.log(`No tart sessions for ${cwd}`)
				return
			}

			for (const session of sessions) {
				yield* Console.log(`${session.sessionId}\t${new Date(session.mtimeMs).toISOString()}\t${session.path}`)
			}
		}),
).pipe(Command.withDescription('List sessions for the current project'))

const config = Command.make('config').pipe(
	Command.withDescription('Manage tart configuration'),
	Command.withSubcommands([
		Command.make('init', { tartHome: commonFlags.tartHome }, (input) =>
			Effect.gen(function* () {
				const tartHome = optionValue(input.tartHome)
				const result = yield* configInit(tartHome === undefined ? {} : { tartHome })
				yield* Console.log(`${result.createdConfig ? 'Created' : 'Found'} ${result.configPath}`)
				yield* Console.log(`Wrote ${result.schemaPath}`)
			}),
		).pipe(Command.withDescription('Create ~/.tart/config.jsonc and config.schema.json')),
		Command.make('validate', { tartHome: commonFlags.tartHome }, (input) =>
			Effect.gen(function* () {
				const tartHome = optionValue(input.tartHome)
				yield* loadTartConfig(tartHome === undefined ? {} : { tartHome })
				yield* Console.log(`Valid ${configPathFor(tartHome === undefined ? {} : { tartHome })}`)
			}),
		).pipe(Command.withDescription('Validate ~/.tart/config.jsonc')),
	]),
)

const auth = Command.make('auth').pipe(
	Command.withDescription('Manage provider authentication'),
	Command.withSubcommands([
		Command.make('codex').pipe(
			Command.withDescription('Manage Codex OAuth credentials'),
			Command.withSubcommands([
				Command.make(
					'login',
					{
						provider: commonFlags.provider,
						tartHome: commonFlags.tartHome,
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
							const tartHome = optionValue(input.tartHome)
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
							const store = makeCodexAuthStore(codexAuthStoreOptions(input.provider, tartHome))
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
						tartHome: commonFlags.tartHome,
						refresh: Flag.boolean('refresh').pipe(
							Flag.withDescription('Refresh an expired credential and persist the repaired token'),
						),
					},
					(input) =>
						Effect.gen(function* () {
							const tartHome = optionValue(input.tartHome)
							const store = makeCodexAuthStore(codexAuthStoreOptions(input.provider, tartHome))
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
									`No Codex credential found in ${store.path}. Run tart auth codex login.`,
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
										? '; run tart auth codex status --refresh to refresh now, or tart auth codex login to reauthenticate'
										: ''
								}`,
							)
						}),
				).pipe(Command.withDescription('Show the stored Codex credential status')),
				Command.make('logout', { provider: commonFlags.provider, tartHome: commonFlags.tartHome }, (input) =>
					Effect.gen(function* () {
						const tartHome = optionValue(input.tartHome)
						const store = makeCodexAuthStore(codexAuthStoreOptions(input.provider, tartHome))
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
					`config not found at ${error.path}; run tart config init or configure ~/.tart/config.jsonc`,
				),
			ConfigParseError: (error) =>
				printFailure(`could not parse config${error.path === null ? '' : ` ${error.path}`}: ${error.message}`),
			ConfigDecodeError: (error) =>
				printFailure(`config shape is invalid${error.path === null ? '' : ` ${error.path}`}: ${error.message}`),
			RoleResolutionError: (error) => printFailure(error.message),
			NoSessionToResumeError: (error) => printFailure(`no tart sessions exist for ${error.cwd}`),
			SessionToResumeNotFoundError: (error) =>
				printFailure(`session ${error.sessionId} was not found for ${error.cwd}`),
			CodexAuthError: (error) => printFailure(error.message),
		}),
	)

/** Effect CLI command tree for the installed `tart` binary. */
export const command = run.pipe(Command.withSubcommands([sessions, config, auth]))

/** Main Effect for the installed CLI binary. */
export const main = withErrorHandling(command.pipe(Command.run({ version })))
