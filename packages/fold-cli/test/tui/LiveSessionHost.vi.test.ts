import { SessionId } from '@humanlayer/fold-core'
import { Deferred, Effect, Exit, Fiber, Schema, Scope } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeLiveSessionHost } from '../../src/tui/LiveSessionHost'

const id = (suffix: string) =>
	Schema.decodeUnknownSync(SessionId)(`sess_${suffix.replace(/[^a-z0-9]/g, '').padEnd(24, 'x')}`)
const snapshot = (value: { sessionId: SessionId; status: 'IDLE' }) => ({ ...value, phase: 'live' as const })

describe('LiveSessionHost', () => {
	it('single-flights concurrent duplicate opens', async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const host = makeLiveSessionHost(yield* Scope.Scope, snapshot)
					const started = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					let acquisitions = 0
					const sessionId = id('duplicate')
					const acquire = Effect.gen(function* () {
						acquisitions++
						yield* Deferred.succeed(started, undefined)
						yield* Deferred.await(release)
						return { sessionId, status: 'IDLE' as const }
					})
					const first = yield* Effect.forkScoped(host.open(sessionId, acquire))
					yield* Deferred.await(started)
					const second = yield* Effect.forkScoped(host.open(sessionId, acquire))
					expect(host.snapshots()).toEqual([{ sessionId, phase: 'acquiring' }])
					yield* Deferred.succeed(release, undefined)
					expect(yield* Fiber.join(first)).toBe(yield* Fiber.join(second))
					expect(acquisitions).toBe(1)
				}),
			),
		)
	})

	it('finishes the shared acquisition when its owning caller is interrupted', async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const host = makeLiveSessionHost(yield* Scope.Scope, snapshot)
					const started = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					const sessionId = id('owner-interrupt')
					const acquire = Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.as({ sessionId, status: 'IDLE' as const }),
					)
					const owner = yield* Effect.forkScoped(host.open(sessionId, acquire))
					yield* Deferred.await(started)
					const waiter = yield* Effect.forkScoped(host.open(sessionId, acquire))
					const interrupting = yield* Effect.forkScoped(Fiber.interrupt(owner))
					yield* Deferred.succeed(release, undefined)

					yield* Fiber.join(interrupting)
					expect(Exit.isFailure(yield* Fiber.await(owner))).toBe(true)
					expect((yield* Fiber.join(waiter)).sessionId).toBe(sessionId)
					expect(host.get(sessionId)?.sessionId).toBe(sessionId)
				}),
			),
		)
	})

	it('prevents stale publication when closed during acquisition', async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const host = makeLiveSessionHost(yield* Scope.Scope, snapshot)
					const started = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					const sessionId = id('close-acquire')
					const opening = yield* Effect.forkScoped(
						host.open(
							sessionId,
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.as({ sessionId, status: 'IDLE' as const }),
							),
						),
					)
					yield* Deferred.await(started)
					yield* host.close(sessionId)
					yield* Deferred.succeed(release, undefined)
					expect(Exit.isFailure(yield* Fiber.await(opening))).toBe(true)
					expect(host.get(sessionId)).toBeNull()
				}),
			),
		)
	})

	it('waits for closing to finish before a new open publishes', async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const host = makeLiveSessionHost(yield* Scope.Scope, snapshot)
					const releasing = yield* Deferred.make<void>()
					const released = yield* Deferred.make<void>()
					const sessionId = id('open-close')
					yield* host.open(
						sessionId,
						Effect.acquireRelease(Effect.succeed({ sessionId, status: 'IDLE' as const }), () =>
							Deferred.succeed(releasing, undefined).pipe(Effect.andThen(Deferred.await(released))),
						),
					)
					const closing = yield* Effect.forkScoped(host.close(sessionId))
					yield* Deferred.await(releasing)
					const alsoClosing = yield* Effect.forkScoped(host.close(sessionId))
					const reopened = yield* Deferred.make<void>()
					const finishReopen = yield* Deferred.make<void>()
					const reopening = yield* Effect.forkScoped(
						host.open(
							sessionId,
							Deferred.succeed(reopened, undefined).pipe(
								Effect.andThen(Deferred.await(finishReopen)),
								Effect.as({ sessionId, status: 'IDLE' as const }),
							),
						),
					)
					expect(host.get(sessionId)).toBeNull()
					yield* Effect.yieldNow
					expect(yield* Deferred.isDone(reopened)).toBe(false)
					yield* Deferred.succeed(released, undefined)
					yield* Fiber.join(closing)
					yield* Fiber.join(alsoClosing)
					yield* Deferred.await(reopened)
					yield* Deferred.succeed(finishReopen, undefined)
					expect((yield* Fiber.join(reopening)).sessionId).toBe(sessionId)
				}),
			),
		)
	})

	it('resolves every waiter on acquisition failure and returned ID mismatch', async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const host = makeLiveSessionHost(yield* Scope.Scope, snapshot)
					for (const [sessionId, acquire] of [
						[id('failure'), Effect.fail('nope')],
						[id('mismatch'), Effect.succeed({ sessionId: id('other'), status: 'IDLE' as const })],
					] as const) {
						const first = yield* Effect.forkScoped(host.open(sessionId, acquire))
						const second = yield* Effect.forkScoped(host.open(sessionId, acquire))
						expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true)
						expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true)
						expect(host.get(sessionId)).toBeNull()
					}
				}),
			),
		)
	})

	it('shuts down pending registrations, releases live sessions, and blocks publication', async () => {
		const released: SessionId[] = []
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const host = makeLiveSessionHost(yield* Scope.Scope, snapshot)
					const liveId = id('live')
					yield* host.register(
						Effect.acquireRelease(
							Effect.succeed({ sessionId: liveId, status: 'IDLE' as const }),
							({ sessionId }) => Effect.sync(() => released.push(sessionId)),
						),
					)
					const started = yield* Deferred.make<void>()
					const finish = yield* Deferred.make<void>()
					const generatedId = id('generated')
					const registering = yield* Effect.forkScoped(
						host.register(
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Deferred.await(finish)),
								Effect.as({ sessionId: generatedId, status: 'IDLE' as const }),
							),
						),
					)
					yield* Deferred.await(started)
					yield* host.closeAll
					yield* Deferred.succeed(finish, undefined)
					expect(Exit.isFailure(yield* Fiber.await(registering))).toBe(true)
					expect(released).toEqual([liveId])
					expect(host.values()).toEqual([])
					const afterShutdown = yield* Effect.exit(
						host.open(liveId, Effect.succeed({ sessionId: liveId, status: 'IDLE' as const })),
					)
					expect(Exit.isFailure(afterShutdown)).toBe(true)
				}),
			),
		)
	})
})
