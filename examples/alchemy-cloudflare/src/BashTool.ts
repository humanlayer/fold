/**
 * The agent's `bash` tool, running commands in the session workspace's shell: just-bash, which covers the
 * common text commands and git but no package managers or language runtimes. fold-agent's bash tool starts
 * real processes, which a Worker cannot; this one keeps its parameters and its output handling - stdout and
 * stderr trimmed to the last 2000 lines or 50KB, and a failure carrying the output when the command fails.
 */
import {
	defaultMaxBytes,
	defaultMaxLines,
	defineTool,
	formatSize,
	ToolResultFailure,
	ToolResultText,
	truncateTail,
	type FoldTool,
} from '@humanlayer/fold-core'
import { Effect, Schema } from 'effect'

import { type CommandInput, type CommandOutput, WORKSPACE_ROOT } from './computer/Contract'
import type { ShellError } from './Workspace'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

const BashParameters = Schema.Struct({
	command: Schema.String.annotate({ description: 'Bash command to execute' }),
	timeout_ms: Schema.optionalKey(Schema.Number).annotate({
		description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS})`,
	}),
	workdir: Schema.optionalKey(Schema.String).annotate({
		description: `Working directory for the command, absolute or relative to ${WORKSPACE_ROOT}. Use this instead of cd.`,
	}),
	description: Schema.optionalKey(Schema.String).annotate({
		description: 'Short (5-10 word) description of what this command does',
	}),
})

const DESCRIPTION =
	`Run a bash command in the session's workspace, where the repo(s) are cloned under ${WORKSPACE_ROOT}. ` +
	'Returns stdout then stderr, keeping the last ' +
	`${defaultMaxLines} lines or ${formatSize(defaultMaxBytes)}. Commands start in ${WORKSPACE_ROOT} unless ` +
	'you pass workdir.\n\n' +
	'This is a lightweight shell (just-bash), not a full Linux machine. It has the common text commands - ' +
	'ls, cat, head, tail, grep, find, sed, awk, sort, uniq, wc, diff, cut, tr, xargs, jq and more - pipes, ' +
	'redirects, and git (clone, status, diff, log, add, commit, branch, checkout). It has no package managers, ' +
	'no node or python, no compilers, and no network access. Use it to explore and search the repos: list ' +
	'directories, grep for code, and inspect git history.'

/** The command's output as the model sees it: stdout, then stderr, trimmed from the front. */
const formatOutput = ({ stdout, stderr }: CommandOutput) => {
	const text = stdout.length > 0 && stderr.length > 0 ? `${stdout.replace(/\n?$/, '\n')}${stderr}` : stdout + stderr
	const truncation = truncateTail(text)
	if (!truncation.truncated) return text
	return `[Showing the last ${truncation.outputLines} of ${truncation.totalLines} lines]\n${truncation.content}`
}

/** Build the bash tool over one session's shell. */
export const bashTool = (run: (input: CommandInput) => Effect.Effect<CommandOutput, ShellError>): FoldTool =>
	defineTool({
		name: 'bash',
		description: DESCRIPTION,
		parameters: BashParameters,
		success: ToolResultText,
		failure: ToolResultFailure,
		handler: (params) =>
			Effect.gen(function* () {
				const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS
				if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
					return yield* Effect.fail(
						`Invalid timeout_ms: must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`,
					)
				}
				const cwd =
					params.workdir === undefined
						? WORKSPACE_ROOT
						: params.workdir.startsWith('/')
							? params.workdir
							: `${WORKSPACE_ROOT}/${params.workdir}`

				const output = yield* run({ command: params.command, cwd, timeoutMs }).pipe(
					Effect.mapError((error) => `The shell could not run the command: ${error.message}`),
				)
				const text = formatOutput(output).replace(/\n+$/, '')

				if (output.status === 'cancelled') {
					return yield* Effect.fail(`${text}\n\nCommand timed out after ${timeoutMs} milliseconds`)
				}
				if (output.exitCode !== 0) {
					return yield* Effect.fail(`${text}\n\nCommand exited with code ${output.exitCode}`)
				}
				return ToolResultText.make({ text: text.length === 0 ? '(no output)' : text })
			}).pipe(Effect.mapError((text) => ToolResultFailure.make({ text }))),
	})
