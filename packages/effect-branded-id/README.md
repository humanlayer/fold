# @humanlayer/effect-branded-id

Type-safe branded IDs for Effect with custom prefixes and CUID2 generation.

## Installation

```bash
bun add @humanlayer/effect-branded-id
```

## Overview

This package provides a factory for creating branded ID schemas that combine:

- **Effect Schema** for runtime validation and type branding
- **CUID2** for collision-resistant ID generation  
- **Custom prefixes** for human-readable, domain-specific identifiers

Generated IDs follow the format: `{prefix}_{cuid2}`

```
usr_ujvy8upptmjyjca5d4vf1ph9
ord_m7k2hx9qp3wn1jc8vb4t6rae
ses_f9d2kg5np8xm3qw7vc1t4yah
```

## Basic Usage

```typescript
import { makeBrandedId, type BrandedIdOf } from "@humanlayer/effect-branded-id"

// Create a branded ID schema
const UserId = makeBrandedId("usr")
type UserId = BrandedIdOf<typeof UserId>

// Generate new IDs
const id = UserId.create()
// => "usr_ujvy8upptmjyjca5d4vf1ph9"

// Type guard
if (UserId.is(someString)) {
  // someString is narrowed to UserId
}

// Validate with Schema
import { Schema } from "effect"

const validated = Schema.decodeUnknownSync(UserId)("usr_ujvy8upptmjyjca5d4vf1ph9")
// => UserId (branded type)

Schema.decodeUnknownSync(UserId)("invalid")
// => throws SchemaError
```

## Type Safety

Different ID types are incompatible at compile time:

```typescript
const UserId = makeBrandedId("usr")
type UserId = BrandedIdOf<typeof UserId>

const OrderId = makeBrandedId("ord")
type OrderId = BrandedIdOf<typeof OrderId>

function getUser(id: UserId) { /* ... */ }

const userId = UserId.create()
const orderId = OrderId.create()

getUser(userId)  // OK
getUser(orderId) // Type error: OrderId is not assignable to UserId
```

## API

### `makeBrandedId(prefix, options?)`

Creates a branded ID schema with factory methods.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `prefix` | `string` | The prefix for generated IDs (e.g., `"usr"`, `"ord"`, `"ses"`). Must be 1-63 lowercase letters/underscores, starting with a letter. |
| `options.brand` | `string` | Optional custom brand name. Defaults to PascalCase of prefix + "Id" (e.g., `"usr"` → `"UsrId"`). |

**Returns:** A branded ID schema with the following properties and methods:

| Property/Method | Type | Description |
|-----------------|------|-------------|
| `brand` | `string` | The brand name for this ID type |
| `prefix` | `string` | The prefix used for generated IDs |
| `create()` | `() => BrandedId<Name>` | Generate a new branded ID with a fresh CUID2 |
| `make(id)` | `(id: string) => BrandedId<Name>` | Create a branded ID from a string (validates) |
| `is(input)` | `(input: string) => input is BrandedId<Name>` | Type guard to check if a string is a valid ID |

The schema also supports all standard Effect Schema operations like `decodeUnknownSync`, `decodeUnknownEffect`, etc.

### `BrandedIdOf<T>`

Type helper to extract the branded ID type from a schema:

```typescript
const UserId = makeBrandedId("usr")
type UserId = BrandedIdOf<typeof UserId>
// => string & Brand<"UsrId">
```

## Examples

### Multi-word Prefixes

Underscores in prefixes are converted to PascalCase for the brand:

```typescript
const UserAccountId = makeBrandedId("user_account")
// brand: "UserAccountId"
// prefix: "user_account"

const id = UserAccountId.create()
// => "user_account_m7k2hx9qp3wn1jc8vb4t6rae"
```

### Custom Brand Names

Override the auto-generated brand name:

```typescript
const Id = makeBrandedId("cst", { brand: "CustomerId" })
// brand: "CustomerId"
// prefix: "cst"
```

### Validation with Effect

```typescript
import { Effect, Schema } from "effect"

const UserId = makeBrandedId("usr")

// Sync validation
try {
  const id = Schema.decodeUnknownSync(UserId)(untrustedInput)
  console.log("Valid:", id)
} catch (e) {
  console.log("Invalid input")
}

// Effect-based validation
const program = Effect.gen(function* () {
  const id = yield* Schema.decodeUnknownEffect(UserId)(untrustedInput)
  return id
})
```

### Using in Database Schemas

```typescript
import { makeBrandedId, type BrandedIdOf } from "@humanlayer/effect-branded-id"
import { Schema } from "effect"

const UserId = makeBrandedId("usr")
type UserId = BrandedIdOf<typeof UserId>

const PostId = makeBrandedId("pst")
type PostId = BrandedIdOf<typeof PostId>

const Post = Schema.Struct({
  id: PostId,
  authorId: UserId,
  title: Schema.String,
  content: Schema.String,
})

// Create a new post
const newPost = {
  id: PostId.create(),
  authorId: UserId.create(),
  title: "Hello World",
  content: "...",
}
```

### Type Guards in Conditionals

```typescript
const UserId = makeBrandedId("usr")

function processId(id: string) {
  if (UserId.is(id)) {
    // id is narrowed to UserId type
    return fetchUser(id)
  }
  throw new Error("Invalid user ID")
}
```

## Validation Rules

IDs are validated against these rules:

1. **Prefix**: Must match the schema's prefix exactly
2. **Separator**: Must have exactly one underscore separating prefix and CUID
3. **CUID2**: Must be 21-32 lowercase alphanumeric characters

Examples of invalid IDs:
- `"usr"` - missing CUID
- `"nounderscore"` - missing prefix separator
- `"ord_abc123"` - wrong prefix (if schema expects `"usr"`)
- `"usr_UPPERCASE"` - CUID must be lowercase
- `"usr_too-short"` - CUID too short and contains invalid characters

## Re-exports

For convenience, the package re-exports utilities from `@paralleldrive/cuid2`:

```typescript
import { isCuid, createId } from "@humanlayer/effect-branded-id"

// Check if a string is a valid CUID2
isCuid("ujvy8upptmjyjca5d4vf1ph9") // true

// Generate a raw CUID2 (without prefix)
createId() // "ujvy8upptmjyjca5d4vf1ph9"
```
