/** @jsxImportSource @opentui/solid */
import {
	launchSession,
	modeForName,
	resumeLatestSession,
	resumeSessionById,
	type LaunchModelError,
	type NoSessionToResumeError,
	type SessionToResumeNotFoundError,
} from '@humanlayer/tart-agent'
import type { TartSession } from '@humanlayer/tart-core'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { Cause, Deferred, Duration, Effect, Match, Schema, Stream, type Scope } from 'effect'
import { batch, createSignal } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'

import type { CliSessionOptions } from '../Run'
import { TuiApp } from './App'
import { executeRootInputAction, unexpectedActionCauseNotice, type RootInputVerb } from './Converse'
import { makeSessionStateFromEntries, reduceSessionEvents } from './SessionState'

export class TuiRequiresTtyError extends Schema.TaggedErrorClass<TuiRequiresTtyError>()('TuiRequiresTtyError', {}) {}

export class TuiRendererError extends Schema.TaggedErrorClass<TuiRendererError>()('TuiRendererError', {
	message: Schema.String,
}) {}

export type TuiOptions = CliSessionOptions & { readonly prompt?: string }

const launchOptions = (options: TuiOptions) => ({
	cwd: options.cwd,
	...(options.tartHome === undefined ? {} : { tartHome: options.tartHome }),
	...(options.mode === undefined ? {} : { mode: modeForName(options.mode) }),
	...(options.rpi === true ? { rpi: true } : {}),
	...(options.profile === undefined ? {} : { profile: options.profile }),
	...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
	...(options.autoCompact === undefined ? {} : { autoCompact: options.autoCompact }),
	...(options.catalog === undefined ? {} : { catalog: options.catalog }),
})

type TuiSessionError = LaunchModelError | NoSessionToResumeError | SessionToResumeNotFoundError

const openSession = (options: TuiOptions): Effect.Effect<TartSession, TuiSessionError, Scope.Scope> => {
	if (options.resume === undefined) return launchSession(launchOptions(options))
	return Match.value(options.resume).pipe(
		Match.tag('latest', () => resumeLatestSession(launchOptions(options))),
		Match.tag('id', ({ sessionId }) => resumeSessionById(sessionId, launchOptions(options))),
		Match.exhaustive,
	)
}

export const runTui = (
	options: TuiOptions,
): Effect.Effect<void, TuiRequiresTtyError | TuiRendererError | TuiSessionError, Scope.Scope> =>
	Effect.gen(function* () {
		if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return yield* new TuiRequiresTtyError()
		const session = yield* openSession(options)
		const replay = yield* session.entries
		const replayHead = replay.at(-1)?.seq ?? -1
		const quit = yield* Deferred.make<void>()
		const [state, setState] = createStore(makeSessionStateFromEntries(replay, session.rootAgentId))
		const [notice, setNotice] = createSignal<string | null>(null)
		const [compacting, setCompacting] = createSignal(false)
		const context = yield* Effect.context<never>()
		const runFork = Effect.runForkWith(context)
		const submit = (verb: RootInputVerb, text: string): void => {
			setNotice(null)
			runFork(executeRootInputAction(session, verb, text, setNotice))
		}
		const compact = (): void => {
			if (compacting()) return
			setCompacting(true)
			setNotice('COMPACTING')
			runFork(
				session.compact().pipe(
					Effect.tap((entry) =>
						Effect.sync(() => setNotice(entry === null ? 'NOTHING TO COMPACT' : 'COMPACTED')),
					),
					Effect.catchCause((cause) => Effect.sync(() => setNotice(unexpectedActionCauseNotice(cause)))),
					Effect.ensuring(Effect.sync(() => setCompacting(false))),
				),
			)
		}
		const interrupt = (): void => {
			setNotice('INTERRUPT REQUESTED')
			runFork(
				session
					.interrupt()
					.pipe(
						Effect.catchCause((cause) => Effect.sync(() => setNotice(unexpectedActionCauseNotice(cause)))),
					),
			)
		}

		const renderer = yield* Effect.tryPromise({
			try: () =>
				createCliRenderer({
					targetFps: 30,
					exitOnCtrlC: false,
					consoleMode: 'disabled',
					useKittyKeyboard: {},
					onDestroy: () => Deferred.doneUnsafe(quit, Effect.void),
				}),
			catch: (error) => new TuiRendererError({ message: String(error) }),
		})
		yield* Effect.addFinalizer(() => Effect.sync(() => renderer.destroy()))
		const copySessionId = (): void => {
			setNotice(renderer.copyToClipboardOSC52(session.sessionId) ? 'SESSION ID COPIED' : 'CLIPBOARD UNAVAILABLE')
		}

		const drain = session.events(replayHead + 1).pipe(
			Stream.groupedWithin(1024, Duration.millis(16)),
			Stream.runForEach((events) =>
				Effect.sync(() => {
					const next = reduceSessionEvents(state, events, session.rootAgentId)
					batch(() => setState(reconcile(next)))
				}),
			),
			Effect.catchCause((cause) =>
				Effect.logError('TUI event stream stopped').pipe(
					Effect.annotateLogs({ session_id: session.sessionId, cause: Cause.pretty(cause) }),
				),
			),
		)
		yield* Effect.forkScoped(drain, { startImmediately: true })
		yield* Effect.yieldNow

		yield* Effect.tryPromise({
			try: () =>
				render(
					() => (
						<TuiApp
							state={() => state}
							cwd={options.cwd}
							sessionId={session.sessionId}
							mode={`${options.mode ?? 'default'}${options.rpi === true ? '+rpi' : ''}`}
							profile={options.profile ?? 'default'}
							notice={notice}
							compacting={compacting}
							onSubmit={submit}
							onCompact={compact}
							onInterrupt={interrupt}
							onCopySessionId={copySessionId}
						/>
					),
					renderer,
				),
			catch: (error) => new TuiRendererError({ message: String(error) }),
		})
		yield* Effect.sync(() => renderer.start())
		if (options.prompt !== undefined) {
			if (options.prompt.trim() === '/compact') yield* Effect.forkScoped(session.compact())
			else yield* Effect.forkScoped(session.send(options.prompt))
		}
		yield* Deferred.await(quit)
	})
