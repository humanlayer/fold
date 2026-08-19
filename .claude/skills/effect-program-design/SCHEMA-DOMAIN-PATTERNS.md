# Fold Schema and Domain Patterns

Schemas define Fold's encoded boundaries: durable log records, host/provider input, and values that must survive a
process or package boundary. Use the smallest model that preserves the contract; do not add class or schema ceremony
to trusted local control flow with no encoded representation.

## Schema chooser

| Value role                                        | Default representation                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Ordinary encoded record                           | `Schema.Struct`                                                                 |
| Closed scalar vocabulary                          | `Schema.Literals`                                                               |
| One encoded `_tag` variant                        | `Schema.TaggedStruct`                                                           |
| Encoded tagged union                              | `Schema.Union` of `Schema.TaggedStruct` variants                                |
| Internal-only tagged decision                     | A precise TypeScript union or `Data.TaggedEnum` when constructors/matchers help |
| Internal-only expected failure                    | `Data.TaggedError`                                                              |
| Error that crosses an encoded boundary            | A schema-backed tagged error, when its codec is required                        |
| Identity with a concrete cross-domain mix-up risk | A constrained branded schema                                                    |

`Schema.TaggedClass` and `Schema.TaggedErrorClass` are not defaults in Fold. Use them only when class identity or
behavior has a real requirement. `Schema.TaggedStruct` and `Data.TaggedError` normally preserve a smaller, clearer
surface.

## Durable tagged events

Fold event-log data is schema-first and versioned. Define each persisted variant with `Schema.TaggedStruct`, then
compose the public union and derive its type from the schema.

```ts
import { Schema } from 'effect'

const UserMessage = Schema.TaggedStruct('user-message', {
	messageId: MessageId,
	message: UserMessageEncoded,
})

const Compaction = Schema.TaggedStruct('compaction', {
	compactionId: CompactionId,
	summary: Schema.String,
})

export const LogEntry = Schema.Union([UserMessage, Compaction]).annotate({
	identifier: 'LogEntry',
	discriminator: '_tag',
})
export type LogEntry = typeof LogEntry.Type
```

When a durable format changes incompatibly, add a new versioned schema and upcast at the decode boundary. Do not
silently change the meaning of a persisted v1 field or use a type assertion to reinterpret historical data.

## Optionality and unknown fields

Choose the exact wire contract:

- `Schema.optionalKey(S)` means a key may be absent.
- `Schema.optional(S)` permits an absent key or an explicit `undefined` value.
- `Schema.NullOr(S)` means the key is present and its value is either `null` or `S`.
- `Schema.Unknown` and `Schema.Json` are valid inside an explicit extensibility/payload boundary. Keep that unknown
  data contained, decoded, or narrowed before it becomes domain behavior.

Do not flatten absent, `undefined`, and `null` merely to make a caller easier to write. Provider and persisted data
often assign different meanings to them.

## Decode before domain behavior

Decode at a file, JSONL, provider, host, or network boundary. Decoding is distinct from constructing a value Fold
already trusts.

```ts
const decodeLogEntry = Schema.decodeUnknownEffect(LogEntry)

const decoded = yield * decodeLogEntry(unknownInput)
const trusted = LogEntry.make(trustedInput)
```

Use `Schema.decodeUnknownEffect` for encoded/untrusted input. Use `make` only when the input is already the schema's
type-side construction input; use `makeEffect` when trusted construction can still legitimately fail in a workflow.
Do not use `as T` to skip decoding.

## Tagged values and errors

After decoding, normal tagged data uses `Predicate` and `Match` according to `PREDICATE-MATCH.md`. Schema decoding
establishes the whole variant shape; `Predicate.isTagged` establishes only a tag and must not replace decoding.

Expected errors retain Effect's error channel. Use `Data.TaggedError` for internal errors, then recover with
`Effect.catchTag` or `Effect.catchTags`. Choose a schema-backed error only when an adapter must encode/decode that
error as part of its public boundary.

## IDs and records

Fold already uses schema-backed IDs where identity matters. Introduce another brand only when it prevents a realistic
cross-domain mix-up or protects a persisted/public contract. A raw string remains correct for freeform text,
provider-owned opaque identifiers, paths, and display values.

Keep repeated durable event fields as schema field constants when it improves consistency. A local helper type is
acceptable for typing a schema filter; do not maintain an exported hand-written object type that duplicates an
exported schema's fields.
