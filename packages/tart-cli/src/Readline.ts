import { stdin as defaultInput, stdout as defaultOutput } from 'node:process'
import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'

import type { TartSession } from '@humanlayer/tart-core'
import { Effect } from 'effect'

import type { OutputRenderer } from './Renderer'

/** Optional streams for hermetic readline tests. */
export type ReadlineOptions = {
	readonly input?: Readable
	readonly output?: Writable
}

const exitCommands = new Set(['exit', '/exit', 'quit', '/quit'])

const ask = (rl: ReturnType<typeof createInterface>, prompt: string): Effect.Effect<string | null> =>
	Effect.promise(() =>
		rl.question(prompt).then(
			(value) => value,
			() => null,
		),
	)

/**
 * Temporary readline loop for humans: blank lines are ignored, `/exit` quits, and Ctrl-C interrupts the
 * active run or exits when idle. This deliberately stays small until the future OpenTUI lands.
 */
export const runInteractive = (
	session: TartSession,
	renderer: OutputRenderer,
	options?: ReadlineOptions,
): Effect.Effect<void> =>
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
				let running = false
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
					if (!running) {
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

				yield* renderer.renderNote('interactive mode: type /exit to quit; Ctrl-C interrupts a running agent')

				while (!closed) {
					const prompt = yield* renderer.prompt
					const line = yield* ask(rl, prompt)
					if (line === null) {
						yield* renderResumeCommandOnce()
						return
					}

					const trimmed = line.trim()
					if (trimmed.length === 0) continue
					if (exitCommands.has(trimmed)) {
						yield* renderResumeCommandOnce()
						return
					}

					running = true
					const finished = yield* session.send(trimmed).pipe(
						Effect.orDie,
						Effect.ensuring(
							Effect.sync(() => {
								running = false
							}),
						),
					)
					yield* Effect.yieldNow
					yield* renderer.renderFinish(finished)
				}
			}),
		(rl) => Effect.sync(() => rl.close()),
	)
