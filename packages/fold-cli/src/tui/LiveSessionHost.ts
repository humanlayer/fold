import type { SessionId } from '@humanlayer/fold-core'
import { Data, Deferred, Effect, Exit, Fiber, Scope, Semaphore } from 'effect'
import { createSignal, type Accessor } from 'solid-js'

export type HostedSessionSnapshot =
	| { readonly sessionId: SessionId; readonly phase: 'acquiring' }
	| {
			readonly sessionId: SessionId
			readonly phase: 'live'
			readonly status: 'RUNNING' | 'IDLE' | 'STOPPED' | 'ERROR'
	  }

type AcquiringSession<A, E> = {
	readonly _tag: 'acquiring'
	readonly result: Deferred.Deferred<A, E | LiveSessionHostClosedError>
	readonly lease: Lease
}

type Lease = { readonly scope: Scope.Closeable; closeDone: Deferred.Deferred<void> | null }

type LiveSession<A> = {
	readonly _tag: 'live'
	readonly value: A
	readonly lease: Lease
}

type ClosingSession = {
	readonly _tag: 'closing'
	readonly lease: Lease
	readonly done: Deferred.Deferred<void>
}

type HostedSession<A, E> = AcquiringSession<A, E> | LiveSession<A> | ClosingSession

type Registration = Lease

export class LiveSessionHostClosedError extends Data.TaggedError('LiveSessionHostClosedError')<{}> {
	override get message(): string {
		return 'Live session host is closed'
	}
}

export type LiveSessionHost<A extends { readonly sessionId: SessionId }, E> = {
	readonly snapshots: Accessor<ReadonlyArray<HostedSessionSnapshot>>
	readonly values: Accessor<ReadonlyArray<A>>
	readonly get: (sessionId: SessionId) => A | null
	readonly open: (
		sessionId: SessionId,
		acquire: Effect.Effect<A, E, Scope.Scope>,
	) => Effect.Effect<A, E | LiveSessionHostClosedError>
	/** Registers a launch whose generated SessionId is not known until acquisition completes. */
	readonly register: <RegisterError>(
		acquire: Effect.Effect<A, RegisterError, Scope.Scope>,
	) => Effect.Effect<A, RegisterError>
	readonly close: (sessionId: SessionId) => Effect.Effect<void>
	/** Permanently shuts down the host and releases pending and live sessions. */
	readonly closeAll: Effect.Effect<void>
}

export const makeLiveSessionHost = <A extends { readonly sessionId: SessionId }, E = never>(
	parentScope: Scope.Scope,
	snapshot: (value: A) => HostedSessionSnapshot,
): LiveSessionHost<A, E> => {
	const sessions = new Map<SessionId, HostedSession<A, E>>()
	const registrations = new Set<Registration>()
	const mutex = Semaphore.makeUnsafe(1)
	let shutdown = false
	const [revision, setRevision] = createSignal(0)
	const [values, setValues] = createSignal<ReadonlyArray<A>>([])
	const snapshots = (): ReadonlyArray<HostedSessionSnapshot> => {
		revision()
		return [...sessions.entries()].flatMap(([sessionId, session]) =>
			session._tag === 'live'
				? [snapshot(session.value)]
				: session._tag === 'acquiring'
					? [{ sessionId, phase: 'acquiring' as const }]
					: [],
		)
	}
	const publish = (): void => {
		setValues([...sessions.values()].flatMap((session) => (session._tag === 'live' ? [session.value] : [])))
		setRevision((current) => current + 1)
	}
	const locked = <B, E, R>(effect: Effect.Effect<B, E, R>) => mutex.withPermits(1)(effect)
	const closeOnce = (record: Lease): Effect.Effect<void> =>
		Effect.suspend(() => {
			if (record.closeDone !== null) return Deferred.await(record.closeDone)
			const done = Deferred.makeUnsafe<void>()
			record.closeDone = done
			return Scope.close(record.scope, Exit.void).pipe(Effect.ensuring(Deferred.succeed(done, undefined)))
		})
	const awaitResult = (result: Deferred.Deferred<A, E | LiveSessionHostClosedError>) => Deferred.await(result)

	const open = (
		sessionId: SessionId,
		acquire: Effect.Effect<A, E, Scope.Scope>,
	): Effect.Effect<A, E | LiveSessionHostClosedError> =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const decision = yield* locked(
					Effect.gen(function* () {
						if (shutdown) return { _tag: 'closed' as const }
						const current = sessions.get(sessionId)
						if (current?._tag === 'live') return { _tag: 'live' as const, value: current.value }
						if (current?._tag === 'acquiring') return { _tag: 'wait' as const, result: current.result }
						if (current?._tag === 'closing') return { _tag: 'closing' as const, done: current.done }
						const pending: AcquiringSession<A, E> = {
							_tag: 'acquiring',
							result: yield* Deferred.make<A, E | LiveSessionHostClosedError>(),
							lease: { scope: Scope.forkUnsafe(parentScope), closeDone: null },
						}
						sessions.set(sessionId, pending)
						publish()
						return { _tag: 'acquire' as const, pending }
					}),
				)
				if (decision._tag === 'closed') return yield* new LiveSessionHostClosedError()
				if (decision._tag === 'live') return decision.value
				if (decision._tag === 'wait') return yield* restore(awaitResult(decision.result))
				if (decision._tag === 'closing') {
					yield* restore(Deferred.await(decision.done))
					return yield* open(sessionId, acquire)
				}

				const { pending } = decision
				const acquisition = yield* Effect.forkIn(
					Scope.provide(pending.lease.scope)(acquire),
					pending.lease.scope,
				)
				// The owner must finish publishing or resolving the shared result even when its caller is
				// interrupted. Waiters remain interruptible, and closing the child scope still interrupts
				// the acquisition fiber immediately.
				let exit = yield* Fiber.await(acquisition)
				if (Exit.isSuccess(exit) && exit.value.sessionId !== sessionId)
					exit = Exit.die(new Error('Session acquisition returned a different SessionId'))
				const published = yield* locked(
					Effect.sync(() => {
						const current = sessions.get(sessionId)
						if (!shutdown && current === pending && Exit.isSuccess(exit)) {
							sessions.set(sessionId, { _tag: 'live', value: exit.value, lease: pending.lease })
							publish()
							return true
						}
						if (current === pending) sessions.delete(sessionId)
						publish()
						return false
					}),
				)
				if (!published) yield* closeOnce(pending.lease)
				const resultExit: Exit.Exit<A, E | LiveSessionHostClosedError> =
					Exit.isSuccess(exit) && published
						? exit
						: Exit.isFailure(exit)
							? exit
							: Exit.fail(new LiveSessionHostClosedError())
				yield* Deferred.done(pending.result, resultExit)
				yield* restore(Effect.yieldNow)
				return yield* restore(awaitResult(pending.result))
			}),
		)

	const register = <RegisterError>(
		acquire: Effect.Effect<A, RegisterError, Scope.Scope>,
	): Effect.Effect<A, RegisterError> =>
		Effect.uninterruptible(
			Effect.gen(function* () {
				const registration: Registration = { scope: Scope.forkUnsafe(parentScope), closeDone: null }
				yield* locked(
					Effect.suspend(() => {
						if (shutdown) return Effect.die(new LiveSessionHostClosedError())
						registrations.add(registration)
						return Effect.void
					}),
				).pipe(Effect.onError(() => closeOnce(registration)))
				const acquisition = yield* Effect.forkIn(Scope.provide(registration.scope)(acquire), registration.scope)
				const exit = yield* Fiber.await(acquisition)
				if (Exit.isFailure(exit)) {
					yield* locked(Effect.sync(() => registrations.delete(registration)))
					yield* closeOnce(registration)
					return yield* Effect.failCause(exit.cause)
				}
				const installed = yield* locked(
					Effect.sync(() => {
						registrations.delete(registration)
						if (shutdown || sessions.has(exit.value.sessionId)) return false
						sessions.set(exit.value.sessionId, {
							_tag: 'live',
							value: exit.value,
							lease: registration,
						})
						publish()
						return true
					}),
				)
				if (installed) return exit.value
				yield* closeOnce(registration)
				if (shutdown) return yield* Effect.die(new LiveSessionHostClosedError())
				const existing = sessions.get(exit.value.sessionId)
				if (existing?._tag === 'live') return existing.value
				return yield* Effect.die(new LiveSessionHostClosedError())
			}),
		)

	const close = (sessionId: SessionId): Effect.Effect<void> =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const decision = yield* locked(
					Effect.gen(function* () {
						const current = sessions.get(sessionId)
						if (current === undefined) return null
						if (current._tag === 'closing') return current
						const closing: ClosingSession = {
							_tag: 'closing',
							lease: current.lease,
							done: yield* Deferred.make<void>(),
						}
						sessions.set(sessionId, closing)
						publish()
						return closing
					}),
				)
				if (decision === null) return
				yield* closeOnce(decision.lease)
				yield* locked(
					Effect.sync(() => {
						if (sessions.get(sessionId) === decision) sessions.delete(sessionId)
						publish()
					}),
				)
				yield* Deferred.succeed(decision.done, undefined)
				yield* restore(Effect.void)
			}),
		)

	const closeAll = Effect.uninterruptibleMask(() =>
		Effect.gen(function* () {
			const idsAndRegistrations = yield* locked(
				Effect.sync(() => {
					shutdown = true
					return { ids: [...sessions.keys()], pending: [...registrations] }
				}),
			)
			yield* Effect.forEach(idsAndRegistrations.ids, close, { concurrency: 'unbounded' })
			yield* Effect.forEach(idsAndRegistrations.pending, closeOnce, { concurrency: 'unbounded' })
		}),
	)

	return {
		snapshots,
		values,
		get: (sessionId) => {
			const session = sessions.get(sessionId)
			return session?._tag === 'live' ? session.value : null
		},
		open,
		register,
		close,
		closeAll,
	}
}
