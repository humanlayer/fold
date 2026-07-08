/**
 * This file implements the bash tool (D18, tart-agent only), combining pi and agentlayer: bash -c in a
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
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import {
	defaultMaxBytes,
	defineTool,
	formatSize,
	InterruptNote,
	ToolEvents,
	truncateTail,
	utf8ByteLength,
	type TartTool,
} from '@humanlayer/tart-core'
import { Context, Duration, Effect, Fiber, Layer, Option, Ref, Schema, Semaphore, Stream } from 'effect'
import { ChildProcess, type ChildProcessSpawner } from 'effect/unstable/process'

import { cwdFor, fileSystemFor, type FsToolOptions } from '../Fs/DefaultFileSystem'
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
	timeout: Schema.optionalKey(Schema.Number).annotate({
		description: 'Timeout in seconds (default 120)',
	}),
	workdir: Schema.optionalKey(Schema.String).annotate({
		description: 'Working directory for the command. Use this instead of cd.',
	}),
	description: Schema.optionalKey(Schema.String).annotate({
		description: 'Short (5-10 word) description of what this command does',
	}),
})

const BashSuccess = Schema.Struct({
	output: Schema.String,
})

const BashFailure = Schema.Struct({
	message: Schema.String,
})

const defaultTimeoutSeconds = 120
const maxTimeoutSeconds = 2_147_483.647
const killGrace = Duration.millis(200)
// Keep a bounded in-memory tail once output spills: 4x the byte limit comfortably covers the
// tail-truncation window while the spill file holds the full output.
const inMemoryRetentionBytes = 4 * defaultMaxBytes

/** Options for {@link bashTool}. */
export type BashToolOptions = FsToolOptions & {
	/** Base directory for spill files holding full untruncated output. Defaults to `os.tmpdir()`. */
	readonly spillDir?: string
}

let spawnerContext: Context.Context<ChildProcessSpawner.ChildProcessSpawner> | null = null

/** The process-wide spawner service, built lazily once over the Node platform layers. */
const defaultSpawner = (): Context.Context<ChildProcessSpawner.ChildProcessSpawner> => {
	if (spawnerContext === null) {
		spawnerContext = Effect.runSync(
			Effect.scoped(
				// Layer.provide keeps only the spawner in the built context; fs/path stay internal.
				Layer.build(
					NodeChildProcessSpawner.layer.pipe(
						Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
					),
				),
			),
		)
	}

	return spawnerContext
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
export const bashTool = (options?: BashToolOptions): TartTool =>
	defineTool({
		name: 'bash',
		description:
			'Execute a bash command and return its output (stdout and stderr interleaved, tail-truncated ' +
			`to 2000 lines or ${formatSize(defaultMaxBytes)} with the full output saved to a file). The command runs in its ` +
			'own process group and is killed at the timeout. Prefer `rg` (ripgrep) over grep/find when available.',
		parameters: BashParameters,
		success: BashSuccess,
		failure: BashFailure,
		handler: (params) =>
			Effect.gen(function* () {
				const fs = fileSystemFor(options)
				const cwd = params.workdir ?? cwdFor(options)
				const timeoutSeconds = params.timeout ?? defaultTimeoutSeconds

				if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
					return yield* Effect.fail({ message: 'Invalid timeout: must be a finite number of seconds' })
				}
				if (timeoutSeconds > maxTimeoutSeconds) {
					return yield* Effect.fail({ message: `Invalid timeout: maximum is ${maxTimeoutSeconds} seconds` })
				}

				if (!(yield* fs.exists(cwd).pipe(Effect.catch(() => Effect.succeed(false))))) {
					return yield* Effect.fail({
						message: `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
					})
				}

				const events = yield* ToolEvents
				const interruptNote = yield* InterruptNote
				const spillPath = join(options?.spillDir ?? tmpdir(), `tart-bash-${randomBytes(8).toString('hex')}.log`)
				const accumulator = yield* makeAccumulator({
					spillPath,
					writeSpill: (path, chunk) =>
						fs.writeFileString(path, chunk, { flag: 'a' }).pipe(Effect.catch(() => Effect.void)),
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
						const decoder = new TextDecoder()
						const push = (text: string): Effect.Effect<void> =>
							text.length === 0
								? Effect.void
								: accumulator
										.append(text)
										.pipe(Effect.andThen(events.emit({ tool: 'bash', stream: name, text })))

						yield* Stream.runForEach(stream, (bytes) => push(decoder.decode(bytes, { stream: true }))).pipe(
							Effect.catch((error) => accumulator.append(`\n[${name} stream error: ${String(error)}]`)),
						)
						// Flush any trailing partial UTF-8 sequence (pi's finish()).
						yield* push(decoder.decode())
					})

				const run = Effect.gen(function* () {
					const handle = yield* ChildProcess.make('bash', ['-c', params.command], {
						cwd,
						env: { PATH: `${join(homedir(), '.tart', 'bin')}:${process.env.PATH ?? ''}` },
						extendEnv: true,
					}).pipe(
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

					const firstExit = yield* awaitExit.pipe(Effect.timeoutOption(Duration.seconds(timeoutSeconds)))
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
				const outcome = yield* Effect.scoped(run).pipe(Effect.provideContext(defaultSpawner()))

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
							`<system-reminder>Command timed out after ${timeoutSeconds} seconds</system-reminder>`,
						),
					})
				}
				if (outcome.exitCode !== null && outcome.exitCode !== 0) {
					return yield* Effect.fail({
						message: appendStatus(outputText, `Command exited with code ${outcome.exitCode}`),
					})
				}

				return { output: outputText.length === 0 ? '(no output)' : outputText }
			}),
	})
