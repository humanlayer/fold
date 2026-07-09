import { join } from 'node:path'

import {
	configInit,
	configPathFor,
	listSessionLogs,
	loadTartConfig,
	type LaunchModelError,
	type ModelSelection,
	type NoSessionToResumeError,
	type SessionToResumeNotFoundError,
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
import { runPrompt, runReadline, type CliSessionOptions } from './Run'

const version = '0.0.0'

const decodeSessionId = Schema.decodeUnknownOption(SessionId)

/** The user supplied a malformed `sess_*` value to `--resume`. */
export class InvalidSessionIdError extends Schema.TaggedErrorClass<InvalidSessionIdError>()('InvalidSessionIdError', {
	value: Schema.String,
}) {}

const optionalString = (name: string, description: string) =>
	Flag.string(name).pipe(Flag.withDescription(description), Flag.optional)

const optionalChoice = <const Choices extends ReadonlyArray<string>>(
	name: string,
	choices: Choices,
	description: string,
) => Flag.choice(name, choices).pipe(Flag.withDescription(description), Flag.optional)

const commonFlags = {
	prompt: optionalString('prompt', 'Run one non-interactive prompt, then exit'),
	resume: optionalString('resume', 'Resume a session id from the current project, e.g. sess_...'),
	provider: optionalString('provider', 'Provider profile key from config.providers'),
	model: optionalString('model', 'Provider model id override for the selected role'),
	role: optionalChoice('role', ['smart', 'fast', 'orchestrator'] as const, 'Config role to resolve'),
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
}

type CommonFlagValues = {
	readonly prompt: Option.Option<string>
	readonly resume: Option.Option<string>
	readonly provider: Option.Option<string>
	readonly model: Option.Option<string>
	readonly role: Option.Option<'smart' | 'fast' | 'orchestrator'>
	readonly reasoning: Option.Option<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
	readonly cwd: Option.Option<string>
	readonly tartHome: Option.Option<string>
	readonly noColor: boolean
	readonly verbose: boolean
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

const sessionIdFromFlag = (raw: string): Effect.Effect<SessionId, InvalidSessionIdError> => {
	const decoded = decodeSessionId(raw)
	return Option.isSome(decoded)
		? Effect.succeed(decoded.value)
		: Effect.fail(new InvalidSessionIdError({ value: raw }))
}

const sessionOptionsFromFlags = (input: CommonFlagValues): Effect.Effect<CliSessionOptions, InvalidSessionIdError> =>
	Effect.gen(function* () {
		const resume = optionValue(input.resume)
		const resumeSessionId = resume === undefined ? undefined : yield* sessionIdFromFlag(resume)
		const tartHome = optionValue(input.tartHome)
		const modelSelection = modelSelectionFromFlags(input)

		return {
			cwd: optionValue(input.cwd) ?? process.cwd(),
			...(tartHome === undefined ? {} : { tartHome }),
			...(resumeSessionId === undefined ? {} : { resumeSessionId }),
			...(modelSelection === undefined ? {} : { modelSelection }),
		}
	})

const run = Command.make('tart', commonFlags, (input) =>
	Effect.scoped(
		Effect.gen(function* () {
			const sessionOptions = yield* sessionOptionsFromFlags(input)
			const renderer = makeOutputRenderer({ colors: !input.noColor, verbose: input.verbose })
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
						device: Flag.boolean('device').pipe(Flag.withDescription('Use the headless device-code flow')),
						browser: Flag.boolean('browser').pipe(
							Flag.withDescription('Use the loopback browser PKCE flow'),
						),
					},
					(input) =>
						Effect.gen(function* () {
							const tartHome = optionValue(input.tartHome)
							const store = makeCodexAuthStore(codexAuthStoreOptions(input.provider, tartHome))
							const codexAuth = yield* makeCodexAuth({
								store,
								onDeviceCode: (prompt) =>
									Console.log(`Open ${prompt.verifyUrl} and enter code: ${prompt.userCode}`),
								onBrowserUrl: (url) => Console.log(`Open this URL to authenticate Codex:\n${url}`),
							}).pipe(Effect.provide(FetchHttpClient.layer))
							const token = yield* input.device && !input.browser
								? codexAuth.authenticateDevice
								: codexAuth.authenticateBrowser

							yield* Console.log(
								`Saved Codex credential${token.accountId === undefined ? '' : ` for account ${token.accountId}`} to ${store.path}`,
							)
						}),
				).pipe(Command.withDescription('Authenticate Codex and persist the OAuth credential')),
				Command.make('status', { provider: commonFlags.provider, tartHome: commonFlags.tartHome }, (input) =>
					Effect.gen(function* () {
						const tartHome = optionValue(input.tartHome)
						const store = makeCodexAuthStore(codexAuthStoreOptions(input.provider, tartHome))
						const token = yield* store.load
						if (Option.isNone(token)) {
							yield* Console.log(`No Codex credential found in ${store.path}`)
							return
						}

						const now = yield* Clock.currentTimeMillis
						const expiry = token.value.isExpired(now) ? 'expired' : 'valid'
						yield* Console.log(
							`Codex credential ${expiry}${
								token.value.accountId === undefined ? '' : ` for account ${token.value.accountId}`
							} in ${store.path}`,
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
			InvalidSessionIdError: (error: InvalidSessionIdError) => printFailure(`invalid session id: ${error.value}`),
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
