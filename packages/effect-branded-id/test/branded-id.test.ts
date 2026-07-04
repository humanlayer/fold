import { it, expect } from '@effect/vitest'
import { Effect, Exit, Schema } from 'effect'

import { makeBrandedId, type BrandedIdOf, isCuid } from '../src/index.js'

const UserId = makeBrandedId('usr')
type UserId = BrandedIdOf<typeof UserId>

const OrderId = makeBrandedId('ord')
type OrderId = BrandedIdOf<typeof OrderId>

it('creates schema with correct brand', () => {
	expect(UserId.brand).toBe('UsrId')
	expect(UserId.prefix).toBe('usr')
})

it('handles multi-word prefixes', () => {
	const UserAccountId = makeBrandedId('user_account')
	expect(UserAccountId.brand).toBe('UserAccountId')
	expect(UserAccountId.prefix).toBe('user_account')
})

it('accepts custom brand name', () => {
	const CustomId = makeBrandedId('cst', { brand: 'MyCustomId' })
	expect(CustomId.brand).toBe('MyCustomId')
})

it('throws on invalid prefix', () => {
	expect(() => makeBrandedId('')).toThrow()
	expect(() => makeBrandedId('123')).toThrow()
	expect(() => makeBrandedId('UPPER')).toThrow()
	expect(() => makeBrandedId('_starts_underscore')).toThrow()
})

it('generates valid IDs with prefix', () => {
	const id = UserId.create()
	expect(id.startsWith('usr_')).toBe(true)
})

it('generates valid CUID2 suffix', () => {
	const id = UserId.create()
	const cuid = id.slice(4) // Remove "usr_"
	expect(isCuid(cuid)).toBe(true)
})

it('generates unique IDs', () => {
	const ids = Array.from({ length: 100 }, () => UserId.create())
	const uniqueIds = new Set(ids)
	expect(uniqueIds.size).toBe(100)
})

it('make() creates branded ID from valid string', () => {
	const id = UserId.create()
	const made = UserId.make(id)
	expect(made).toBe(id)
})

it('make() validates input and throws on invalid', () => {
	// In Effect Schema, make() validates. Use for trusted input that still needs type narrowing.
	expect(() => UserId.make('usr_invalid')).toThrow()
})

it('is() returns true for valid IDs', () => {
	const id = UserId.create()
	expect(UserId.is(id)).toBe(true)
})

it('is() returns false for wrong prefix', () => {
	const orderId = OrderId.create()
	expect(UserId.is(orderId)).toBe(false)
})

it('is() returns false for invalid CUID', () => {
	expect(UserId.is('usr_notacuid')).toBe(false)
})

it('is() returns false for malformed input', () => {
	expect(UserId.is('')).toBe(false)
	expect(UserId.is('usr')).toBe(false)
	expect(UserId.is('nounderscore')).toBe(false)
})

it.effect('decodes valid IDs', () =>
	Effect.gen(function* () {
		const id = UserId.create()
		const exit = yield* Effect.exit(Schema.decodeUnknownEffect(UserId)(id))
		expect(exit).toStrictEqual(Exit.succeed(id))
	}),
)

it.effect('fails to decode wrong prefix', () =>
	Effect.gen(function* () {
		const orderId = OrderId.create()
		const exit = yield* Effect.exit(Schema.decodeUnknownEffect(UserId)(orderId))
		expect(exit._tag).toBe('Failure')
	}),
)

it.effect('fails to decode invalid CUID', () =>
	Effect.gen(function* () {
		const exit = yield* Effect.exit(Schema.decodeUnknownEffect(UserId)('usr_invalid'))
		expect(exit._tag).toBe('Failure')
	}),
)

it.effect('fails to decode missing prefix', () =>
	Effect.gen(function* () {
		const exit = yield* Effect.exit(Schema.decodeUnknownEffect(UserId)('noprefixhere'))
		expect(exit._tag).toBe('Failure')
	}),
)

it('different ID types are incompatible at compile time', () => {
	// This test verifies compile-time behavior
	// TypeScript should prevent: getUser(OrderId.create())
	const _userId: UserId = UserId.create()
	const _orderId: OrderId = OrderId.create()

	// @ts-expect-error - UserId and OrderId should be incompatible
	const _wrongAssignment: UserId = _orderId

	expect(true).toBe(true) // Test passes if it compiles
})
