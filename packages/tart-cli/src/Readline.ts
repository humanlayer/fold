/**
 * This file is the temporary interactive readline loop (D26; OpenTUI replaces it later). The loop
 * never blocks on a run: a plain message forks the root run into the ambient scope and keeps reading,
 * so further input can steer the running agent (plain text or /steer by agent id), message subagents
 * (/send), request a graceful stop (/stop), or exit (/exit interrupts an active run first). Command
 * parsing is the pure `parseInteractiveInput`; run state is the one `activeRun` fiber.
 */
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process'
import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'

import type { AgentFinishedLogEntry, TartSession } from '@humanlayer/tart-core'
import { Cause, Effect, Exit, Fiber, type Scope } from 'effect'

import { parseInteractiveInput } from './InteractiveCommand'
import type { OutputRenderer } from './Renderer'

/** Optional streams for hermetic readline tests. */
export type ReadlineOptions = {
	readonly input?: Readable
	readonly output?: Writable
}

const helpText = [
	'commands:',
	'  <text>                    start a run when idle; steer the running agent otherwise',
	'  /steer <agent_id> <text>  steer a specific running agent',
	'  /send <agent_id> <text>   message a subagent by id (resumes it when finished)',
	'  /compact                  force a root-agent compaction now',
	'  /stop [reason]            graceful stop: agents finish the current tool batch, then stop',
	'  /help                     show this help',
	'  /exit                     interrupt any active run and quit (Ctrl-C interrupts; exits when idle)',
	'agent ids (agent_...) are printed on agent start and finish lines; the short form shown there works everywhere',
].join('\n')

const ask = (rl: ReturnType<typeof createInterface>, prompt: string): Effect.Effect<string | null> =>
	Effect.promise(() =>
		rl.question(prompt).then(
			(value) => value,
			() => null,
		),
	)

/**
 * Interactive loop for humans: reads lines while runs are in flight. Plain text starts the root run
 * when idle and steers it when active; /steer, /send, /stop, /help, /exit per `parseInteractiveInput`.
 * Ctrl-C interrupts the active run or exits when idle. This deliberately stays small until the future
 * OpenTUI lands.
 */
export const runInteractive = (
	session: TartSession,
	renderer: OutputRenderer,
	options?: ReadlineOptions,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.acquireUseRelease(
		Effect.sync(() =>
			createInterface({
				input: options?.input ?? defaultInput,
				output: options?.output ?? defaultOutput,
			}),
		),
		(rl) =>
			Effect.gen(function* () {
				const context = yield* Effect.context<never>()
				let closed = false
				let activeRun: Fiber.Fiber<AgentFinishedLogEntry> | null = null
				let printedResumeCommand = false
				const renderResumeCommandOnce = (): Effect.Effect<void> => {
					if (printedResumeCommand) return Effect.void
					printedResumeCommand = true
					return renderer.renderResumeCommand
				}

				rl.on('close', () => {
					closed = true
				})
				rl.on('SIGINT', () => {
					if (activeRun === null) {
						closed = true
						rl.close()
						return
					}

					Effect.runForkWith(context)(
						renderer
							.renderNote('interrupt requested; saving session state')
							.pipe(Effect.andThen(session.interrupt())),
					)
				})

				// The root run: completes independently of the readline loop, prints its finish exactly as
				// the blocking loop used to, and clears itself as the active run. A fiber interrupted from
				// scope teardown still writes the durable D10 markers via session.interrupt().
				const rootRunEffect = (text: string): Effect.Effect<AgentFinishedLogEntry> =>
					session.send(text).pipe(
						Effect.orDie,
						Effect.onExit((exit) =>
							Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) ? session.interrupt() : Effect.void,
						),
						Effect.tap((finished) => Effect.yieldNow.pipe(Effect.andThen(renderer.renderFinish(finished)))),
						Effect.ensuring(
							Effect.sync(() => {
								activeRun = null
							}),
						),
					)

				const startRootRun = (text: string): Effect.Effect<void, never, Scope.Scope> =>
					Effect.gen(function* () {
						activeRun = yield* Effect.forkScoped(rootRunEffect(text))
					})

				// Only ever ONE root run: plain text starts it when idle and steers it when active. The
				// AgentNotRunningError fallback covers the race where the run ended between the check and
				// the steer reaching the session.
				const dispatchMessage = (text: string): Effect.Effect<void, never, Scope.Scope> =>
					activeRun === null
						? startRootRun(text)
						: session.steer(text).pipe(Effect.catchTag('AgentNotRunningError', () => startRootRun(text)))

				// A /send target completes through the live event stream; the one-line note keeps it
				// distinct from the root run (no exit-code bookkeeping, no [done] block of its own). The
				// target is a full id or a short reference; the session resolves it.
				const subagentSendEffect = (agentId: string, text: string): Effect.Effect<void> =>
					session.send(text, { agentId }).pipe(
						Effect.onExit((exit) =>
							Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
								? session.interrupt({ agentId })
								: Effect.void,
						),
						Effect.flatMap((finished) =>
							Effect.yieldNow.pipe(
								Effect.andThen(
									renderer.renderNote(
										`agent ${finished.agentId} ${finished.outcome}${finished.reason === null ? '' : ` (${finished.reason})`}`,
									),
								),
							),
						),
						Effect.catchTag('SubagentNotFoundError', (error) =>
							renderer.renderError(`no agent with id "${error.requested}" exists in this session`),
						),
					)

				// /exit and EOF land here: an active run is interrupted (durable markers) and awaited so
				// its finish renders before the resume hint.
				const endActiveRun = (): Effect.Effect<void> =>
					Effect.gen(function* () {
						const fiber = activeRun
						if (fiber === null) return
						yield* renderer.renderNote('interrupt requested; saving session state')
						yield* session.interrupt()
						yield* Fiber.await(fiber)
					})

				yield* renderer.renderNote('type a message to begin - /help for commands')

				while (!closed) {
					const prompt = yield* renderer.prompt
					const line = yield* ask(rl, prompt)
					if (line === null) break

					const command = parseInteractiveInput(line)
					switch (command._tag) {
						case 'message': {
							if (command.text.length === 0) continue
							yield* dispatchMessage(command.text)
							continue
						}
						case 'steer': {
							yield* session
								.steer(command.text, { agentId: command.agentId })
								.pipe(
									Effect.catchTag('AgentNotRunningError', (error) =>
										renderer.renderNote(error.message),
									),
								)
							continue
						}
						case 'send': {
							yield* Effect.forkScoped(subagentSendEffect(command.agentId, command.text))
							continue
						}
						case 'compact': {
							const compaction = yield* session.compact()
							yield* renderer.renderNote(
								compaction === null
									? 'compaction skipped; there is nothing safe to summarize yet'
									: `compacted through seq ${compaction.replacesThroughSeq} (${compaction.tokensBefore} tokens)`,
							)
							continue
						}
						case 'stop': {
							yield* session.stop(command.reason)
							yield* renderer.renderNote(
								'stop requested; agents will stop at the next tool-batch boundary',
							)
							continue
						}
						case 'help': {
							yield* renderer.renderNote(helpText)
							continue
						}
						case 'invalid': {
							yield* renderer.renderError(command.message)
							continue
						}
						case 'exit': {
							closed = true
							continue
						}
					}
				}

				yield* endActiveRun()
				yield* renderResumeCommandOnce()
			}),
		(rl) => Effect.sync(() => rl.close()),
	)
