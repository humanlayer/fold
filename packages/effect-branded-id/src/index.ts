import { createId } from '@paralleldrive/cuid2'
import { Brand, Schema } from 'effect'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attaches static factory methods to a schema.
 * Inspired by opencode's statics pattern.
 */
const statics =
	<S extends object, M extends Record<string, unknown>>(methods: (schema: S) => M) =>
	(schema: S): S & M =>
		Object.assign(schema, methods(schema))

/**
 * Prefix validation regex - lowercase letters and underscores, 1-63 chars
 */
const prefixRegex = /^[a-z][a-z_]{0,61}[a-z]?$/

/**
 * Validates that a prefix matches the allowed format
 */
const isValidPrefix = (prefix: string): boolean => prefixRegex.test(prefix)

/**
 * Validates a CUID2 string more strictly than the library's isCuid.
 * CUID2s are 24 characters of lowercase alphanumeric by default.
 */
const isValidCuid = (cuid: string): boolean => {
	// CUID2 default length is 24, all lowercase alphanumeric
	if (cuid.length < 21 || cuid.length > 32) return false
	// Must be lowercase alphanumeric only
	return /^[a-z0-9]+$/.test(cuid)
}

/**
 * Extracts prefix and cuid from a branded ID string
 */
const parseId = (id: string, expectedPrefix: string): { prefix: string; cuid: string } | null => {
	const separatorIndex = id.lastIndexOf('_')
	if (separatorIndex === -1) return null

	const prefix = id.slice(0, separatorIndex)
	const cuid = id.slice(separatorIndex + 1)

	if (prefix !== expectedPrefix) return null
	if (!isValidCuid(cuid)) return null

	return { prefix, cuid }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A branded ID type with a specific prefix brand
 */
export type BrandedId<Name extends string> = string & Brand.Brand<Name>

/**
 * Infer the branded ID type from a BrandedIdSchema
 */
export type BrandedIdOf<T> = T extends { readonly Type: infer A } ? A : never

/**
 * Extra methods added to branded ID schemas
 */
export interface BrandedIdMethods<Name extends string> {
	/** The brand name for this ID type */
	readonly brand: Name
	/** The prefix used for this ID type */
	readonly prefix: string
	/**
	 * Create a new branded ID with a fresh CUID2
	 * @example
	 * const id = UserId.create() // "usr_ckopqwo2c0000ql08smxycfk"
	 */
	readonly create: () => BrandedId<Name>
	/**
	 * Check if a string is a valid ID for this type
	 * @example
	 * UserId.is("usr_ckopqwo2c0000ql08smxycfk") // true
	 * UserId.is("invalid") // false
	 */
	readonly is: (input: string) => input is BrandedId<Name>
}

/**
 * Options for creating a branded ID schema
 */
export interface BrandedIdOptions<Name extends string> {
	/**
	 * The brand name for the ID type.
	 * This becomes the TypeScript brand and appears in error messages.
	 * @example "UserId", "OrderId", "SessionId"
	 */
	readonly brand: Name
}

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

/**
 * Error thrown when a branded ID fails validation
 */
export class BrandedIdError extends Schema.TaggedErrorClass<BrandedIdError>()('BrandedIdError', {
	input: Schema.String,
	message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Schema Factory
// ---------------------------------------------------------------------------

/**
 * Default brand name from prefix: "usr" -> "UsrId", "user_account" -> "UserAccountId"
 */
type DefaultBrandName<Prefix extends string> = Prefix extends `${infer Head}_${infer Tail}`
	? `${Capitalize<Head>}${DefaultBrandName<Tail>}`
	: `${Capitalize<Prefix>}Id`

/**
 * Creates a branded ID schema with a custom prefix and CUID2 suffix.
 *
 * The generated IDs follow the format: `{prefix}_{cuid2}`
 *
 * @example
 * ```ts
 * // Create a schema for user IDs
 * const UserId = makeBrandedId("usr")
 * type UserId = BrandedIdOf<typeof UserId>
 *
 * // Generate a new ID
 * const id = UserId.create() // "usr_ckopqwo2c0000ql08smxycfk"
 *
 * // Validate external input
 * const parsed = Schema.decodeUnknownSync(UserId)("usr_ckopqwo2c0000ql08smxycfk")
 *
 * // Type safety: UserId cannot be used where OrderId is expected
 * const OrderId = makeBrandedId("ord")
 * type OrderId = BrandedIdOf<typeof OrderId>
 *
 * function getUser(id: UserId) { ... }
 * getUser(OrderId.create()) // Type error!
 * ```
 *
 * @param prefix - The prefix for generated IDs (e.g., "usr", "ord", "ses")
 * @param options - Optional configuration including custom brand name
 * @returns A branded ID schema with create/make/is methods
 */
export const makeBrandedId = <const Prefix extends string, const Name extends string = DefaultBrandName<Prefix>>(
	prefix: Prefix,
	options?: BrandedIdOptions<Name>,
) => {
	// Validate prefix at schema creation time
	if (!isValidPrefix(prefix)) {
		throw new Error(
			`Invalid prefix "${prefix}": must be 1-63 lowercase letters/underscores, starting with a letter`,
		)
	}

	// Derive brand name from prefix if not provided
	const brand = (options?.brand ??
		prefix
			.split('_')
			.map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
			.join('') + 'Id') as Name

	// Validation function that checks both prefix and CUID
	const isValid = (input: string): boolean => parseId(input, prefix) !== null

	// Create error message based on input
	const getErrorMessage = (input: string): string => {
		const separatorIndex = input.lastIndexOf('_')
		if (separatorIndex === -1) {
			return `Invalid ${brand}: missing prefix, expected format "${prefix}_<cuid2>"`
		}
		const actualPrefix = input.slice(0, separatorIndex)
		if (actualPrefix !== prefix) {
			return `Invalid ${brand}: expected prefix "${prefix}_", got "${actualPrefix}_"`
		}
		return `Invalid ${brand}: invalid CUID2 suffix`
	}

	// Create a filter using Effect 4.x API: Schema.makeFilter
	const idFilter = Schema.makeFilter<string>((input) => (isValid(input) ? undefined : getErrorMessage(input)), {
		identifier: brand,
	})

	// Build the schema using pipe pattern like opencode:
	// String -> check with filter -> brand -> statics
	return Schema.String.check(idFilter).pipe(
		Schema.brand(brand),
		statics((s) => ({
			brand,
			prefix,
			create: (): BrandedId<Name> => s.make(`${prefix}_${createId()}`) as unknown as BrandedId<Name>,
			is: (input: string): input is BrandedId<Name> => isValid(input),
		})),
	)
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { isCuid, createId } from '@paralleldrive/cuid2'
