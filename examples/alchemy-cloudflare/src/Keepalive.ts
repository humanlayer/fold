/**
 * Wakes a Durable Object that lost a running turn. Pending work - model calls, calls to the Computer, timers -
 * keeps the object in memory without a connected client (compatibility date 2026-10-01 and later), but a
 * deploy or crash can still end it mid-turn, and nothing else would wake it before the next message. So
 * each piece of work holds a lease, and while any lease is held the object's alarm fires every
 * {@link HEARTBEAT_MILLIS} and re-arms itself. An alarm that finds the object restarted wakes it, and the
 * object continues the cut-off turn as it starts (see ChatSession).
 */
import * as Cloudflare from 'alchemy/Cloudflare'
import { Clock, Context, Effect, Layer, Ref } from 'effect'

const HEARTBEAT_MILLIS = 30_000

export class Keepalive extends Context.Service<
	Keepalive,
	{
		/** Run `effect` under a lease: the first lease arms the heartbeat. */
		readonly whileRunning: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
		/**
		 * The object's alarm handler: re-arm while any lease is held. Returns whether it did; once no lease is
		 * held, the alarm is the caller's.
		 */
		readonly alarm: Effect.Effect<boolean>
	}
>()('alchemy-cloudflare/Keepalive') {
	static readonly layer = Layer.effect(
		Keepalive,
		Effect.gen(function* () {
			// The raw storage handle: its alarm call needs nothing at call time, so neither do these methods.
			const { raw } = yield* Cloudflare.DurableObjectState
			const leases = yield* Ref.make(0)
			const armHeartbeat = Effect.flatMap(Clock.currentTimeMillis, (now) =>
				Effect.promise(() => raw.storage.setAlarm(now + HEARTBEAT_MILLIS)),
			)

			return Keepalive.of({
				whileRunning: (effect) =>
					Effect.acquireUseRelease(
						Ref.updateAndGet(leases, (held) => held + 1).pipe(
							Effect.tap((held) => (held === 1 ? armHeartbeat : Effect.void)),
						),
						() => effect,
						() => Ref.update(leases, (held) => held - 1),
					),
				alarm: Effect.flatMap(Ref.get(leases), (held) =>
					held > 0 ? Effect.as(armHeartbeat, true) : Effect.succeed(false),
				),
			})
		}),
	)
}
