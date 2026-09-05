/**
 * This file implements the bash tool (D18, fold-agent only), combining pi and agentlayer: bash -c in a
 * detached process group; agentlayer's kill choreography on timeout and interruption (SIGTERM to the
 * group, 200ms grace, then SIGKILL - implemented here by racing the spawner's kill-await against the
 * grace period, since effect's `forceKillAfter` only bounds the signal send). stdout/stderr stream
 * live as schema-typed ToolEvents deltas ({@link BashOutputDelta}) while both accumulate interleaved
 * (arrival order) into one serialized buffer that is TAIL-truncated at 2000 lines / 50KB (errors live
 * at the end - pi), and stream INTO the spill log file from the first byte (ruling 2026-07-07) - so an
 * interrupted command's partial output is already on disk, and the InterruptNote this handler sets
 * makes the synthetic interrupted tool result name that path. Stream errors (EPIPE and friends)
 * degrade to inline notes, never crash the run. Non-zero exit and timeout are typed model-visible
 * failures carrying the accumulated output; signal-killed commands are successes (pi semantics).
 */
import { homedir, tmpdir } from 'node:os'

import {
	defaultMaxBytes,
	defineTool,
	formatSize,
	CurrentToolCall,
	InterruptNote,
	platformToolDependencies,
	ToolEvents,
	ToolResultFailure,
	ToolResultText,
	truncateTail,
	utf8ByteLength,
	type FoldTool,
} from '@humanlayer/fold-core'
import { Data, Duration, Effect, Fiber, FileSystem, Option, Path, Random, Ref, Schema, Semaphore, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { resolveToCwd } from '../Fs/PathResolve'
import type { OutputStoreService } from '../OutputStore/OutputStore'
import { platformErrorMessage } from './ReadTool'

/**
 * The schema of one live bash output delta as emitted through ToolEvents (and surfaced on the session
 * event stream as `tool-progress` payloads). Consumers discriminate stdout from stderr by decoding
 * payloads with this schema.
 */
export const BashOutputDelta = Schema.Struct({
	tool: Schema.Literal('bash'),
	stream: Schema.Union([Schema.Literal('stdout'), Schema.Literal('stderr')]),
	text: Schema.String,
})
export type BashOutputDelta = typeof BashOutputDelta.Type

const isBashOutputDelta = Schema.is(BashOutputDelta)

/** Decode one tool-progress payload as a bash output delta; null when it is something else. */
export const decodeBashOutputDelta = (payload: unknown): BashOutputDelta | null =>
	isBashOutputDelta(payload) ? payload : null

const BashParameters = Schema.Struct({
	command: Schema.String.annotate({ description: 'Bash command to execute' }),
	timeout_ms: Schema.optionalKey(Schema.Number).annotate({
		description: 'Timeout in milliseconds (default 120000)',
	}),
	workdir: Schema.optionalKey(Schema.String).annotate({
		description: 'Working directory for the command. Use this instead of cd.',
	}),
	description: Schema.optionalKey(Schema.String).annotate({
		description: 'Short (5-10 word) description of what this command does',
	}),
})

const BashSuccess = ToolResultText

const BashFailure = ToolResultFailure

const defaultTimeoutMilliseconds = 120_000
const maxTimeoutMilliseconds = 2_147_483_647
const killGrace = Duration.millis(200)
// Keep a bounded in-memory tail once output spills: 4x the byte limit comfortably covers the
// tail-truncation window while the spill file holds the full output.
const inMemoryRetentionBytes = 4 * defaultMaxBytes

class BashOutputNotTextError extends Data.TaggedError('BashOutputNotTextError')<{
	readonly stream: 'stdout' | 'stderr'
	readonly cause?: unknown
}> {}

class BashOutputStreamError extends Data.TaggedError('BashOutputStreamError')<{
	readonly stream: 'stdout' | 'stderr'
	readonly cause: unknown
}> {}

const omittedNonTextOutputMessage = (stream: 'stdout' | 'stderr') =>
	`\n[${stream} output omitted because it contained binary data or invalid UTF-8]`

/** Options for {@link bashTool}. */
export type BashToolOptions = {
	/** Working directory for resolving relative paths. Defaults to `process.cwd()` at call time. */
	readonly cwd?: string
	/** Base directory for spill files holding full untruncated output. Defaults to `os.tmpdir()`. */
	readonly spillDir?: string
	/** Deterministic per-session output store. When absent, bash uses the legacy temp spill file. */
	readonly outputStore?: OutputStoreService
	/** Environment entries inherited by every Bash subprocess created by this tool. */
	readonly processEnvironment?: Readonly<Record<string, string>>
}

type AccumulatorState = {
	chunks: ReadonlyArray<string>
	inMemoryBytes: number
	totalBytes: number
	totalNewlines: number
	lastLineBytes: number
	endsWithNewline: boolean
}

type AccumulatorSnapshot = {
	readonly text: string
	readonly totalLines: number
	readonly lastLineBytes: number
}

/** Interleaved output accumulator streaming every chunk to the spill file as it is written. */
type Accumulator = {
	readonly append: (text: string) => Effect.Effect<void>
	readonly snapshot: Effect.Effect<AccumulatorSnapshot>
	readonly spillPath: string
}

const makeAccumulator = (input: {
	readonly writeSpill: (path: string, chunk: string) => Effect.Effect<void>
	readonly spillPath: string
}): Effect.Effect<Accumulator> =>
	Effect.gen(function* () {
		// The spill file exists from the start (ruling 2026-07-07): output streams into it as it is
		// written, so an interrupted command's partial output is already on disk at the noted path.
		yield* input.writeSpill(input.spillPath, '')

		const state = yield* Ref.make<AccumulatorState>({
			chunks: [],
			inMemoryBytes: 0,
			totalBytes: 0,
			totalNewlines: 0,
			lastLineBytes: 0,
			endsWithNewline: false,
		})
		// The stdout and stderr fibers append concurrently, and an append suspends on file IO between
		// reading and writing the state; serialize the whole append to keep it atomic.
		const lock = yield* Semaphore.make(1)

		const append = (text: string): Effect.Effect<void> =>
			lock.withPermit(
				Effect.gen(function* () {
					if (text.length === 0) return
					const bytes = utf8ByteLength(text)
					const newlines = text.split('\n').length - 1
					const afterLastNewline = text.slice(text.lastIndexOf('\n') + 1)

					yield* input.writeSpill(input.spillPath, text)

					const current = yield* Ref.get(state)
					let chunks = [...current.chunks, text]
					let inMemoryBytes = current.inMemoryBytes + bytes
					// The in-memory buffer only needs the tail-truncation window; the file holds it all.
					while (inMemoryBytes > inMemoryRetentionBytes && chunks.length > 1) {
						const dropped = chunks[0] ?? ''
						chunks = chunks.slice(1)
						inMemoryBytes -= utf8ByteLength(dropped)
					}

					yield* Ref.set(state, {
						chunks,
						inMemoryBytes,
						totalBytes: current.totalBytes + bytes,
						totalNewlines: current.totalNewlines + newlines,
						lastLineBytes: newlines > 0 ? utf8ByteLength(afterLastNewline) : current.lastLineBytes + bytes,
						endsWithNewline: text.endsWith('\n'),
					})
				}),
			)

		return {
			append,
			snapshot: Ref.get(state).pipe(
				Effect.map((current) => ({
					text: current.chunks.join(''),
					// pi's line counting: a trailing newline terminates the last line, never opens one.
					totalLines:
						current.totalBytes === 0 ? 0 : current.totalNewlines + (current.endsWithNewline ? 0 : 1),
					lastLineBytes: current.lastLineBytes,
				})),
			),
			spillPath: input.spillPath,
		}
	})

/** Build the truncation notice (pi's model-facing formats, with the spill path embedded). */
const truncationNotice = (input: {
	readonly outputLines: number
	readonly totalLines: number
	readonly truncatedBy: 'lines' | 'bytes'
	readonly lastLinePartial: boolean
	readonly contentBytes: number
	readonly lastLineBytes: number
	readonly spillPath: string
}): string => {
	const start = input.totalLines - input.outputLines + 1
	const end = input.totalLines

	if (input.lastLinePartial) {
		return `[Showing last ${formatSize(input.contentBytes)} of line ${end} (line is ${formatSize(input.lastLineBytes)}). Full output: ${input.spillPath}]`
	}
	if (input.truncatedBy === 'lines') {
		return `[Showing lines ${start}-${end} of ${input.totalLines}. Full output: ${input.spillPath}]`
	}
	return `[Showing lines ${start}-${end} of ${input.totalLines} (${formatSize(defaultMaxBytes)} limit). Full output: ${input.spillPath}]`
}

/** pi's appendStatus: prefix the status with output when there is any. */
const appendStatus = (text: string, status: string): string => (text.length > 0 ? `${text}\n\n${status}` : status)

/**
 * Kill the process group with escalation: SIGTERM, a 200ms grace, then SIGKILL (agentlayer). The
 * spawner's kill sends the signal to the group immediately and then awaits exit, so racing that await
 * against the grace period and following up with SIGKILL reproduces the choreography; effect's own
 * `forceKillAfter` only bounds the signal send, so it never escalates for TERM-ignoring processes.
 */
const killWithEscalation = (handle: ChildProcessSpawner.ChildProcessHandle): Effect.Effect<void> =>
	Effect.gen(function* () {
		const graceful = yield* handle.kill({ killSignal: 'SIGTERM' }).pipe(
			Effect.timeoutOption(killGrace),
			Effect.catch(() => Effect.succeed(Option.some<void>(undefined))),
		)

		if (Option.isNone(graceful)) {
			yield* handle.kill({ killSignal: 'SIGKILL' }).pipe(
				Effect.timeoutOption(Duration.seconds(5)),
				Effect.catch(() => Effect.succeed(Option.none<void>())),
			)
		}
	})

/** Build the bash tool. Runs real processes; only spill-file IO goes through the FileSystem seam. */
export const bashTool = (options?: BashToolOptions): FoldTool =>
	defineTool({
		name: 'bash',
		description:
			'Execute a bash command and return its output (stdout and stderr interleaved, tail-truncated ' +
			`to 2000 lines or ${formatSize(defaultMaxBytes)} with the full output saved to a file). The command runs in its ` +
			'own process group and is killed at the timeout. The optional timeout_ms is in milliseconds ' +
			`(default ${defaultTimeoutMilliseconds}, maximum ${maxTimeoutMilliseconds}).\n\n` +
			'Fast search binaries are provided on PATH (fold auto-installs them into ~/.fold/bin): prefer ' +
			'`rg` over grep for content search, `fd` over find for locating files by name (fast and ' +
			'gitignore-aware), and `ast-grep` for syntax-aware structural search over code. ' +
			'`ast-grep outline <file-or-dir>` prints a structural table of contents - functions, classes, ' +
			'imports, and exports with their line ranges - so use it to map a file before reading it; ' +
			'`ast-grep outline <file> --match <Symbol> --view expanded` expands one symbol in detail.',
		parameters: BashParameters,
		success: BashSuccess,
		failure: BashFailure,
		dependencies: platformToolDependencies,
		handler: (params) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const pathService = yield* Path.Path
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				const configuredCwd = yield* resolveToCwd(options?.cwd ?? process.cwd(), process.cwd())
				const cwd =
					params.workdir === undefined ? configuredCwd : yield* resolveToCwd(params.workdir, configuredCwd)
				const timeoutMilliseconds = params.timeout_ms ?? defaultTimeoutMilliseconds

				if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
					return yield* Effect.fail({
						message: 'Invalid timeout_ms: must be a finite number of milliseconds',
					})
				}
				if (timeoutMilliseconds > maxTimeoutMilliseconds) {
					return yield* Effect.fail({
						message: `Invalid timeout_ms: maximum is ${maxTimeoutMilliseconds} milliseconds`,
					})
				}

				if (!(yield* fs.exists(cwd).pipe(Effect.catch(() => Effect.succeed(false))))) {
					return yield* Effect.fail({
						message: `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
					})
				}

				const events = yield* ToolEvents
				const interruptNote = yield* InterruptNote
				const currentToolCall = yield* CurrentToolCall
				const outputStore = options?.outputStore
				const spillRef = outputStore?.refFor(currentToolCall.toolCallId)
				const spillToken = `${(yield* Random.next).toString(36).slice(2)}${(yield* Random.next).toString(36).slice(2)}`
				const spillPath =
					spillRef?.path ?? pathService.join(options?.spillDir ?? tmpdir(), `fold-bash-${spillToken}.log`)
				const accumulator = yield* makeAccumulator({
					spillPath,
					writeSpill: (path, chunk) =>
						outputStore === undefined
							? fs
									.writeFileString(path, chunk, { flag: 'a' })
									.pipe(
										Effect.catch((error) =>
											Effect.logWarning(
												`could not persist bash output at ${path}: ${error.message}`,
											),
										),
									)
							: outputStore
									.append(currentToolCall.toolCallId, chunk)
									.pipe(
										Effect.catch((error) =>
											Effect.logWarning(
												`could not persist bash output at ${path}: ${error.message}`,
											),
										),
									),
				})

				// If this call is interrupted, the synthetic tool result points the model at the partial
				// output, which streams into the spill file as the command writes it.
				yield* interruptNote.set(
					`The command's partial output (stdout and stderr, up to the interruption) is saved at ` +
						`${spillPath}; read or search that file to see what it produced.`,
				)

				/**
				 * Consume one output stream: decode UTF-8 (per-stream decoder with a final flush),
				 * accumulate interleaved, and emit typed live deltas. EPIPE and friends degrade to an
				 * inline note, never crash the run (D18).
				 */
				const consume = (
					stream: Stream.Stream<Uint8Array, unknown>,
					name: 'stdout' | 'stderr',
				): Effect.Effect<void> =>
					Effect.gen(function* () {
						const decoder = new TextDecoder('utf-8', { fatal: true })
						let rejectedNonTextOutput = false
						const push = (text: string): Effect.Effect<void> =>
							text.length === 0
								? Effect.void
								: accumulator
										.append(text)
										.pipe(Effect.andThen(events.emit({ tool: 'bash', stream: name, text })))
						const decode = (bytes?: Uint8Array): Effect.Effect<string, BashOutputNotTextError> =>
							Effect.try({
								try: () => {
									const text = decoder.decode(bytes, { stream: bytes !== undefined })
									if (text.includes('\0')) throw new Error('null byte in process output')
									return text
								},
								catch: (cause) => new BashOutputNotTextError({ stream: name, cause }),
							})

						yield* Stream.runForEach(
							stream.pipe(Stream.mapError((cause) => new BashOutputStreamError({ stream: name, cause }))),
							(bytes) => decode(bytes).pipe(Effect.flatMap(push)),
						).pipe(
							Effect.catchTags({
								BashOutputNotTextError: () => {
									rejectedNonTextOutput = true
									return push(omittedNonTextOutputMessage(name))
								},
								BashOutputStreamError: (error) =>
									accumulator.append(`\n[${name} stream error: ${String(error.cause)}]`),
							}),
						)
						if (!rejectedNonTextOutput) {
							yield* decode().pipe(
								Effect.flatMap(push),
								Effect.catchTag('BashOutputNotTextError', () =>
									push(omittedNonTextOutputMessage(name)),
								),
							)
						}
					})

				const run = Effect.gen(function* () {
					const inheritedPath = options?.processEnvironment?.PATH ?? process.env.PATH ?? ''
					const handle = yield* spawner
						.spawn(
							ChildProcess.make('bash', ['-c', params.command], {
								cwd,
								env: {
									...options?.processEnvironment,
									PATH: `${pathService.join(homedir(), '.fold', 'bin')}:${inheritedPath}`,
								},
								extendEnv: true,
							}),
						)
						.pipe(
							Effect.mapError((error) => ({
								message: `Failed to start command: ${platformErrorMessage('bash', params.command, error)}`,
							})),
						)

					// On interruption the spawner's own finalizer only SIGTERMs the group and awaits exit;
					// this finalizer runs first (LIFO) and adds the SIGKILL escalation so a TERM-ignoring
					// process cannot hang scope close.
					yield* Effect.addFinalizer(() => killWithEscalation(handle))

					const stdoutFiber = yield* Effect.forkScoped(consume(handle.stdout, 'stdout'))
					const stderrFiber = yield* Effect.forkScoped(consume(handle.stderr, 'stderr'))

					// null = killed by a signal (no exit code): pi treats that as success, not an error.
					const awaitExit: Effect.Effect<number | null> = handle.exitCode.pipe(
						Effect.map((code) => Number(code)),
						Effect.catch(() => Effect.succeed(null)),
					)

					const firstExit = yield* awaitExit.pipe(Effect.timeoutOption(Duration.millis(timeoutMilliseconds)))
					let timedOut = false
					let exitCode: number | null
					if (Option.isSome(firstExit)) {
						exitCode = firstExit.value
					} else {
						timedOut = true
						yield* killWithEscalation(handle)
						const afterKill = yield* awaitExit.pipe(Effect.timeoutOption(Duration.seconds(5)))
						exitCode = Option.isSome(afterKill) ? afterKill.value : null
					}

					// Bounded post-exit drain: detached descendants can hold the pipes open forever (pi #5303).
					yield* Effect.raceFirst(
						Fiber.join(stdoutFiber).pipe(Effect.zip(Fiber.join(stderrFiber))),
						Effect.sleep(Duration.millis(500)),
					)
					yield* Fiber.interrupt(stdoutFiber)
					yield* Fiber.interrupt(stderrFiber)

					return { exitCode, timedOut }
				})

				// The scope bounds the child process; interruption triggers the escalating group kill above.
				const outcome = yield* Effect.scoped(run)

				const { text, totalLines, lastLineBytes } = yield* accumulator.snapshot
				const truncation = truncateTail(text)
				let outputText = truncation.content

				if (truncation.truncated) {
					const notice = truncationNotice({
						outputLines: truncation.outputLines,
						totalLines,
						truncatedBy: truncation.truncatedBy ?? 'bytes',
						lastLinePartial: truncation.lastLinePartial,
						contentBytes: utf8ByteLength(truncation.content),
						lastLineBytes,
						spillPath: accumulator.spillPath,
					})
					outputText += `\n\n${notice}`
				}

				if (outcome.timedOut) {
					return yield* Effect.fail({
						message: appendStatus(
							outputText,
							`<system-reminder>Command timed out after ${timeoutMilliseconds} milliseconds</system-reminder>`,
						),
					})
				}
				if (outcome.exitCode !== null && outcome.exitCode !== 0) {
					return yield* Effect.fail({
						message: appendStatus(outputText, `Command exited with code ${outcome.exitCode}`),
					})
				}

				return ToolResultText.make({ text: outputText.length === 0 ? '(no output)' : outputText })
			}).pipe(Effect.mapError((error) => ToolResultFailure.make({ text: error.message }))),
	})
