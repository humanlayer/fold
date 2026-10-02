/**
 * Deletes an idle session. Every message pushes the session's deadline to {@link IDLE_TIME} from now. Once no turn is running, the object's alarm is set for the deadline; when it fires past
 * the deadline, the session's workspace is deleted, then the object's own storage, and the object restarts
 * empty, so its id is new again.
 *
 * The alarm is shared with {@link Keepalive}: while a turn runs, Keepalive's heartbeat holds it, and the
 * heartbeat that finds no turn running hands it back here.
 */
import * as Cloudflare from 'alchemy/Cloudflare'
import { Clock, Context, Duration, Effect, Layer, Option, Schema } from 'effect'

/** How long a session lasts after its last message. */
export const IDLE_TIME = Duration.days(14)

const DEADLINE_KEY = 'session_deadline'

/** How long after deleting the session the object restarts. */
const RESTART_DELAY_MILLIS = 1_000

/** What SessionExpiry needs from the Durable Object: its key-value storage, alarm, and a restart. */
export type ExpiryStorage = {
	readonly get: (key: string) => Effect.Effect<number | undefined>
	readonly put: (key: string, value: number) => Effect.Effect<void>
	readonly getAlarm: Effect.Effect<number | null>
	readonly setAlarm: (at: number) => Effect.Effect<void>
	/** Delete the alarm and every stored value. */
	readonly deleteAll: Effect.Effect<void>
	/** Throw away the object's in-memory state, so the next call starts from its (empty) storage. */
	readonly restart: Effect.Effect<void>
}

export class SessionExpiry extends Context.Service<
	SessionExpiry,
	{
		/** Push the deadline back to the idle time from now. Returns the new deadline, in epoch milliseconds. */
		readonly touch: Effect.Effect<number>
		/** Whether the deadline has passed: the session is waiting for its alarm to delete it. */
		readonly expired: Effect.Effect<boolean>
		/** Give a written session an alarm if it has none, such as one written before expiry existed. */
		readonly ensureScheduled: Effect.Effect<void>
		/**
		 * The object's alarm when no turn holds it: past the deadline, run `deleteWorkspace` and delete the
		 * session; before it, set the alarm for the deadline. A session with no deadline was already deleted
		 * (or never written), so there is nothing to do.
		 */
		readonly alarm: (deleteWorkspace: Effect.Effect<void>) => Effect.Effect<void>
	}
>()('alchemy-cloudflare/SessionExpiry') {
	static readonly make = (storage: ExpiryStorage, idleTime: Duration.Duration) => {
		const touch = Effect.gen(function* () {
			const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(idleTime)
			yield* storage.put(DEADLINE_KEY, deadline)
			return deadline
		})

		return SessionExpiry.of({
			touch,
			expired: Effect.gen(function* () {
				const deadline = yield* storage.get(DEADLINE_KEY)
				return deadline !== undefined && (yield* Clock.currentTimeMillis) >= deadline
			}),
			ensureScheduled: Effect.gen(function* () {
				if ((yield* storage.getAlarm) !== null) return
				const deadline = (yield* storage.get(DEADLINE_KEY)) ?? (yield* touch)
				yield* storage.setAlarm(deadline)
			}),
			alarm: (deleteWorkspace) =>
				Effect.gen(function* () {
					const deadline = yield* storage.get(DEADLINE_KEY)
					if (deadline === undefined) return
					if ((yield* Clock.currentTimeMillis) < deadline) return yield* storage.setAlarm(deadline)

					yield* deleteWorkspace
					yield* storage.deleteAll
					yield* Effect.logInfo('session.expired')
					yield* storage.restart
				}),
		})
	}

	/** Over the Durable Object's storage, with {@link IDLE_TIME}. */
	static readonly layer = Layer.effect(
		SessionExpiry,
		Effect.gen(function* () {
			const { raw } = yield* Cloudflare.DurableObjectState

			return SessionExpiry.make(
				{
					get: (key) =>
						Effect.promise(() => raw.storage.get(key)).pipe(
							Effect.map((value) =>
								Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Finite)(value)),
							),
						),
					put: (key, value) => Effect.promise(() => raw.storage.put(key, value)),
					getAlarm: Effect.promise(() => raw.storage.getAlarm()),
					setAlarm: (at) => Effect.promise(() => raw.storage.setAlarm(at)),
					deleteAll: Effect.promise(async () => {
						await raw.storage.deleteAlarm()
						await raw.storage.deleteAll()
					}),
					// Once the alarm has finished: Cloudflare holds its completion until the delete is saved,
					// and an abort before then fails the alarm, which Cloudflare retries.
					restart: Effect.sleep(Duration.millis(RESTART_DELAY_MILLIS)).pipe(
						// abort throws to unwind; the object resets either way.
						Effect.andThen(Effect.try(() => raw.abort('session expired'))),
						Effect.ignore,
						Effect.forkDetach(),
						Effect.asVoid,
					),
				},
				IDLE_TIME,
			)
		}),
	)
}
