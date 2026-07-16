import {
	makeDiskSkillSource,
	modeForName,
	switchSessionMode,
	type ProfileModeName,
	type FoldConfig,
} from '@humanlayer/fold-agent'
import { renderSkillContent, type ModelCatalogEntry, type SessionId, type FoldSession } from '@humanlayer/fold-core'
import { Cause, Duration, Effect, Scope, Stream } from 'effect'
import { batch, createSignal, type Accessor } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'

import { executeRootInputAction, unexpectedActionCauseNotice, type RootInputVerb } from './Converse'
import { type ModelSelectionRequest } from './ModelSelectionState'
import { makeSessionStateFromEntries, reduceSessionEvents, type SessionState } from './SessionState'

export type HostedTuiSessionMetadata = {
	readonly cwd: string
	readonly profile: string
	readonly mode: ProfileModeName
}

export type HostedTuiSession = {
	readonly sessionId: SessionId
	readonly session: FoldSession
	readonly cwd: string
	readonly profile: Accessor<string>
	readonly mode: Accessor<ProfileModeName>
	readonly state: Accessor<SessionState>
	readonly notice: Accessor<string | null>
	readonly targetNotice: Accessor<{ readonly agentId: string; readonly text: string } | null>
	readonly compacting: Accessor<boolean>
	readonly initialInputFocused: boolean
	readonly submit: (verb: RootInputVerb, text: string) => void
	readonly compact: () => void
	readonly interrupt: () => void
	readonly stop: () => void
	readonly targetSubmit: (agentId: string, text: string, verb: RootInputVerb) => void
	readonly targetInterrupt: (agentId: string) => void
	readonly injectSkill: (name: string, agentId: string | null) => void
	readonly configureModels: (selection: ModelSelectionRequest) => void
	readonly notify: (notice: string | null) => void
}

export const makeHostedTuiSession = (
	session: FoldSession,
	options: {
		readonly metadata: HostedTuiSessionMetadata
		readonly initialInputFocused: boolean
		readonly config: Accessor<FoldConfig | null>
		readonly configNotice: string | null
		readonly foldHome?: string
		readonly catalog?: ReadonlyArray<ModelCatalogEntry>
		readonly rpi?: boolean
		readonly onDurableSummaryChange: () => void
	},
): Effect.Effect<HostedTuiSession, never, Scope.Scope> =>
	Effect.gen(function* () {
		const context = yield* Effect.context<Scope.Scope>()
		const runRoot = Effect.runForkWith(context)
		const run = <A, E>(effect: Effect.Effect<A, E>): void => {
			runRoot(Effect.forkScoped(effect, { startImmediately: true }))
		}
		const replay = yield* Effect.orDie(session.entries)
		const replayHead = replay.at(-1)?.seq ?? -1
		const [state, setState] = createStore(makeSessionStateFromEntries(replay, session.rootAgentId))
		const [notice, setNotice] = createSignal<string | null>(null)
		const [targetNotice, setTargetNotice] = createSignal<{
			readonly agentId: string
			readonly text: string
		} | null>(null)
		const [compacting, setCompacting] = createSignal(false)
		const [profile, setProfile] = createSignal(options.metadata.profile)
		const [mode, setMode] = createSignal(options.metadata.mode)
		const failNotice = (cause: Cause.Cause<unknown>) => unexpectedActionCauseNotice(cause)

		const submit = (verb: RootInputVerb, text: string): void => {
			setNotice(null)
			run(executeRootInputAction(session, verb, text, setNotice))
		}
		const compact = (): void => {
			if (compacting()) return
			setCompacting(true)
			setNotice('COMPACTING')
			run(
				session.compact().pipe(
					Effect.tap((entry) =>
						Effect.sync(() => setNotice(entry === null ? 'NOTHING TO COMPACT' : 'COMPACTED')),
					),
					Effect.catchCause((cause) => Effect.sync(() => setNotice(failNotice(cause)))),
					Effect.ensuring(Effect.sync(() => setCompacting(false))),
				),
			)
		}
		const interrupt = (): void => {
			setNotice('INTERRUPT REQUESTED')
			run(session.interrupt().pipe(Effect.catchCause((cause) => Effect.sync(() => setNotice(failNotice(cause))))))
		}
		const stop = (): void => {
			setNotice('STOP REQUESTED')
			run(
				session
					.stop('Requested from command palette')
					.pipe(Effect.catchCause((cause) => Effect.sync(() => setNotice(failNotice(cause))))),
			)
		}
		const targetSubmit = (agentId: string, text: string, verb: RootInputVerb): void => {
			setNotice(null)
			setTargetNotice({ agentId, text: verb === 'send' ? 'RESUMING SUBAGENT' : 'SUBAGENT MESSAGE QUEUED' })
			run(
				(verb === 'steer'
					? session
							.steer(text, { agentId })
							.pipe(Effect.catchTag('AgentNotRunningError', () => session.send(text, { agentId })))
					: verb === 'interrupt-send'
						? session.interrupt({ agentId }).pipe(Effect.andThen(session.send(text, { agentId })))
						: session.send(text, { agentId })
				).pipe(
					Effect.tap(() => Effect.sync(() => setTargetNotice({ agentId, text: 'SUBAGENT READY' }))),
					Effect.catchCause((cause) =>
						Effect.sync(() => setTargetNotice({ agentId, text: failNotice(cause) })),
					),
				),
			)
		}
		const targetInterrupt = (agentId: string): void => {
			setNotice(null)
			setTargetNotice({ agentId, text: 'SUBAGENT INTERRUPT REQUESTED' })
			run(
				session
					.interrupt({ agentId })
					.pipe(
						Effect.catchCause((cause) =>
							Effect.sync(() => setTargetNotice({ agentId, text: failNotice(cause) })),
						),
					),
			)
		}
		const injectSkill = (name: string, agentId: string | null): void => {
			if (agentId === null) {
				setTargetNotice(null)
				setNotice(`INJECTING SKILL · ${name}`)
			} else {
				setNotice(null)
				setTargetNotice({ agentId, text: `INJECTING SKILL · ${name}` })
			}
			run(
				Effect.gen(function* () {
					const source = yield* makeDiskSkillSource({ cwd: options.metadata.cwd })
					const skill = yield* source.load(name)
					yield* session.injectSkill(
						name,
						renderSkillContent(skill),
						agentId === null ? undefined : { agentId },
					)
					if (agentId === null) setNotice(`SKILL INJECTED · ${name}`)
					else setTargetNotice({ agentId, text: `SKILL INJECTED · ${name}` })
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() => {
							const text = Cause.pretty(cause)
							if (agentId === null) setNotice(text)
							else setTargetNotice({ agentId, text })
						}),
					),
				),
			)
		}
		const configureModels = (selection: ModelSelectionRequest): void => {
			const config = options.config()
			if (config === null) {
				setNotice(options.configNotice)
				return
			}
			setNotice('APPLYING MODEL CONFIGURATION')
			run(
				switchSessionMode(session, {
					mode: modeForName(selection.mode ?? mode()),
					cwd: options.metadata.cwd,
					config,
					...(options.foldHome === undefined ? {} : { foldHome: options.foldHome }),
					...(options.catalog === undefined ? {} : { catalog: options.catalog }),
					...(options.rpi === true ? { rpi: true } : {}),
					...(selection._tag === 'profile'
						? { profile: selection.profile }
						: { modelSelection: { provider: selection.provider, model: selection.model } }),
					reason: `TUI switch to ${selection.mode ?? mode()} mode`,
				}).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							setProfile(selection._tag === 'profile' ? selection.profile : 'direct')
							setMode(selection.mode ?? mode())
							setNotice('MODEL AND MODE CONFIGURATION APPLIED')
						}),
					),
					Effect.catchCause((cause) => Effect.sync(() => setNotice(Cause.pretty(cause)))),
				),
			)
		}

		const drain = session.events(replayHead + 1).pipe(
			Stream.groupedWithin(1024, Duration.millis(16)),
			Stream.runForEach((events) =>
				Effect.sync(() => {
					const next = reduceSessionEvents(state, events, session.rootAgentId)
					batch(() => setState(reconcile(next)))
					if (
						Array.from(events).some(
							(event) =>
								event.kind === 'log' &&
								[
									'session_title',
									'user-message',
									'assistant-message',
									'agent-finished',
									'model-change',
								].includes(event.entry._tag),
						)
					)
						options.onDurableSummaryChange()
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

		return {
			sessionId: session.sessionId,
			session,
			cwd: options.metadata.cwd,
			profile,
			mode,
			state: () => state,
			notice,
			targetNotice,
			compacting,
			initialInputFocused: options.initialInputFocused,
			submit,
			compact,
			interrupt,
			stop,
			targetSubmit,
			targetInterrupt,
			injectSkill,
			configureModels,
			notify: setNotice,
		}
	})
