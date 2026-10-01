/**
 * SessionExpiry against an in-memory Durable Object store, with Effect's test clock standing in for time.
 */
import { it } from '@effect/vitest'
import { Duration, Effect, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import { expect } from 'vitest'

import { type ExpiryStorage, SessionExpiry } from '../src/SessionExpiry'

const DAY = Duration.toMillis(Duration.days(1))

/** A fake object: its stored values, its alarm, and whether it was deleted or restarted. */
const fakeObject = Effect.gen(function* () {
	const values = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
	const alarm = yield* Ref.make<number | null>(null)
	const events = yield* Ref.make<ReadonlyArray<string>>([])
	const record = (event: string) => Ref.update(events, (all) => [...all, event])

	const storage: ExpiryStorage = {
		get: (key) => Effect.map(Ref.get(values), (all) => all.get(key)),
		put: (key, value) => Ref.update(values, (all) => new Map(all).set(key, value)),
		getAlarm: Ref.get(alarm),
		setAlarm: (at) => Ref.set(alarm, at),
		deleteAll: Effect.andThen(Ref.set(values, new Map()), Ref.set(alarm, null)).pipe(
			Effect.andThen(record('deleteAll')),
		),
		restart: record('restart'),
	}
	const expiry = SessionExpiry.make(storage, Duration.days(14))
	return { expiry, alarm: Ref.get(alarm), events: Ref.get(events), deleteWorkspace: record('deleteWorkspace') }
})

it.effect('each message pushes the deadline back', () =>
	Effect.gen(function* () {
		const { expiry } = yield* fakeObject

		expect(yield* expiry.touch).toBe(14 * DAY)
		yield* TestClock.adjust(Duration.days(3))
		expect(yield* expiry.touch).toBe(17 * DAY)
	}),
)

it.effect('before the deadline, the alarm waits for it', () =>
	Effect.gen(function* () {
		const { expiry, alarm, events, deleteWorkspace } = yield* fakeObject
		yield* expiry.touch
		yield* TestClock.adjust(Duration.days(1))

		yield* expiry.alarm(deleteWorkspace)
		expect(yield* alarm).toBe(14 * DAY)
		expect(yield* events).toEqual([])
	}),
)

it.effect('past the deadline, the alarm deletes the workspace, then the session, then restarts', () =>
	Effect.gen(function* () {
		const { expiry, alarm, events, deleteWorkspace } = yield* fakeObject
		yield* expiry.touch
		yield* TestClock.adjust(Duration.days(14))

		yield* expiry.alarm(deleteWorkspace)
		expect(yield* events).toEqual(['deleteWorkspace', 'deleteAll', 'restart'])
		expect(yield* alarm).toBeNull()
	}),
)

it.effect('a message after an earlier alarm keeps the session alive past the first deadline', () =>
	Effect.gen(function* () {
		const { expiry, alarm, events, deleteWorkspace } = yield* fakeObject
		yield* expiry.touch
		yield* TestClock.adjust(Duration.days(10))
		yield* expiry.touch
		yield* TestClock.adjust(Duration.days(4))

		yield* expiry.alarm(deleteWorkspace)
		expect(yield* alarm).toBe(24 * DAY)
		expect(yield* events).toEqual([])
	}),
)

it.effect('an alarm with no deadline stored does nothing: the session is already gone', () =>
	Effect.gen(function* () {
		const { expiry, alarm, events, deleteWorkspace } = yield* fakeObject

		yield* expiry.alarm(deleteWorkspace)
		expect(yield* alarm).toBeNull()
		expect(yield* events).toEqual([])
	}),
)

it.effect('a written session without an alarm gets one; an existing alarm is left alone', () =>
	Effect.gen(function* () {
		const { expiry, alarm } = yield* fakeObject

		yield* expiry.ensureScheduled
		expect(yield* alarm).toBe(14 * DAY)

		yield* TestClock.adjust(Duration.days(1))
		yield* expiry.ensureScheduled
		expect(yield* alarm).toBe(14 * DAY)
	}),
)

it.effect('the session counts as expired from its deadline until it is deleted', () =>
	Effect.gen(function* () {
		const { expiry, deleteWorkspace } = yield* fakeObject
		expect(yield* expiry.expired).toBe(false)

		yield* expiry.touch
		yield* TestClock.adjust(Duration.days(13))
		expect(yield* expiry.expired).toBe(false)
		yield* TestClock.adjust(Duration.days(1))
		expect(yield* expiry.expired).toBe(true)

		yield* expiry.alarm(deleteWorkspace)
		expect(yield* expiry.expired).toBe(false)
	}),
)
