# Predicate and Match for Fold

Use this reference when working with ordinary tagged values such as log entries, model descriptors, provider
settings, and in-process decisions. It does not replace typed Effect error handling.

## Choose the right construct

| Situation                                          | Use                                                  | Why                                                                   |
| -------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| Recover from a tagged failure in `Effect<A, E, R>` | `Effect.catchTag` / `Effect.catchTags`               | The error stays in the error channel.                                 |
| Test one tag or create a reusable narrowing filter | `Predicate.isTagged`                                 | Produces a guard that works with `find`, `filter`, and guard clauses. |
| Reuse a multi-tag narrowing filter                 | Compose `Predicate.isTagged` guards                  | Keeps the narrowed union in one named predicate.                      |
| Transform every member of a closed tagged union    | `Match.type<T>()` with `Match.tagsExhaustive`        | Makes added variants a type error at the transformation.              |
| Dispatch a closed union at one call site           | `Match.value(value)`                                 | Keeps the cases and their result together.                            |
| Handle only selected tags intentionally            | `Match.tag` / `Match.tags` plus an explicit fallback | Documents that unmatched values are expected.                         |

`Match` selects a branch for an ordinary value. A branch may return an `Effect`, but `Match` neither runs it nor
recovers its failures. Use `catchTag` / `catchTags` after an Effect has failed with a typed error.

## Predicate: narrow, do not decode

Use `Predicate.isTagged` when a caller needs one narrow branch or a named refinement for an array operation. The
value must already be trusted as the union type. `Predicate.isTagged` proves only the `_tag` value; it does not check
the remaining fields.

```ts
import { Predicate } from 'effect'

type MessageEntry = Extract<LogEntry, { readonly _tag: 'user-message' | 'assistant-message' }>

const isMessageEntry: Predicate.Refinement<LogEntry, MessageEntry> = Predicate.or(
	Predicate.isTagged('user-message'),
	Predicate.isTagged('assistant-message'),
)

const transcriptEntries = entries.filter(isMessageEntry)
```

For an untrusted value from JSON, a provider, a file, or a host boundary, decode it with the owning `Schema` first.
Do not use `Predicate.isTagged` or a hand-written `typeof`/property ladder as a substitute for decoding.

Use a direct tag check when it is a single local guard in a loop and extracting a predicate would obscure the control
flow. Prefer a named predicate when the condition recurs, combines tags, or expresses domain vocabulary.

## Match: transform complete unions

Use `Match.type<T>()` to define a reusable transformation. `Match.tagsExhaustive` is the default for a closed union:
it must cover every tag, so a new schema variant makes the compiler identify every transformation that needs a case.

```ts
import { Match } from 'effect'

const sessionIdFromIndexRecord = Match.type<SessionIndexRecord>().pipe(
	Match.tagsExhaustive({
		summary: ({ summary }) => summary.sessionId,
		deleted: ({ sessionId }) => sessionId,
	}),
)
```

Use `Match.value(value)` for a one-off dispatch. It is especially useful when each case has a distinct output and a
conditional chain would repeat the discriminant.

```ts
const status = Match.value(lastFinished.outcome).pipe(
	Match.when('completed', () => 'ready' as const),
	Match.when('error', () => 'error' as const),
	Match.orElse(() => 'stopped' as const),
)
```

An explicit `Match.orElse` or `Match.option` is appropriate only when partial handling is intentional. Do not use a
fallback merely to suppress exhaustiveness for a union whose variants Fold owns.

## Boundaries and errors remain separate

```ts
const decodeEntry = Schema.decodeUnknownEffect(LogEntry)

const recoverProviderError = providerCall.pipe(
	Effect.catchTags({
		ProviderUnavailable: () => Effect.succeed(fallback),
		ProviderUnauthenticated: () => Effect.succeed(fallback),
	}),
)
```

The first line decodes an unknown boundary value. The second block recovers typed failures. Neither should be
rewritten as an ordinary-value `Match`.

## Review checklist

- Is this a normal tagged value or a typed failure? Use `Predicate`/`Match` only for the former.
- Has untrusted data already been decoded by the owning schema?
- Does a reusable tag condition deserve a named `Predicate` refinement?
- Does a Fold-owned closed union deserve `Match.tagsExhaustive`?
- Would a direct local `_tag` guard communicate a simple loop condition more clearly? Keep it when yes.
