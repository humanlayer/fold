---
name: effect-program-design
description: >-
    Design, write, and review Effect service modules (Context.Service + Layer) using the riptide-api
    "deep module" pattern. Use when creating or changing an Effect service, external adapter, tagged
    error, layer, or its @effect/vitest tests; or when reviewing Effect code for module depth, typed-error
    capture-then-narrow, observability (spans/logs/Sentry), Config/Redacted secrets, and real-seam layer
    tests. The Slack service (apps/riptide-api/src/effects/services/slack) is the canonical reference.
---

# Effect Program Design

Build **deep** Effect service modules: a small, domain-shaped public surface hiding substantial behavior,
with typed success **and** error channels, declared dependencies, capture-then-narrow error handling, spans,
and tests that swap real layers at real seams. The Slack service is the gold standard. `workos`, `resend`,
`stripe`, and `s3` are shallow foils — do not copy them.

CANONICAL references on Effect v4 (effect-smol):

- https://effect-ts-effect-smol.mintlify.app/introduction
- ~/projects/effect-smol

## The creed (non-negotiables)

1. **Deep modules.** The interface is the _cost_, the implementation is the _benefit_. Hide a lot behind a
   small, simple shape. The caller never learns the module's internals.
2. **Everything stays in Effect.** Typed success **and** error channels; dependencies declared in `R` (Effect
   services), never passed as arguments. No plain functions that receive/inspect errors or carry errors as values.
3. **Two-tier errors, capture-then-narrow.** Classify raw failures into tagged errors → capture (log + Sentry)
   **before** narrowing → map to a small, caller-actionable public union. `catchTag`/`catchTags` only — never
   `instanceof`, never `error._tag === '…'`.
4. **Observe everything.** A span per public method, structured logs, Sentry for the actionable/unexpected —
   all with safe fields, secrets `Redacted`.
5. **Testable by layer substitution.** Every service is exercised through its public interface with deps
   swapped as layers (`@effect/vitest` + `Effect.provide`). No module mocks, no method spies.

> See `REFERENCE.md` for the annotated file skeleton, copy-paste stubs, and the anti-pattern catalog with
> in-repo line references.
> See `SCHEMA-DOMAIN-PATTERNS.md` for schema-first domain modeling: `Schema.TaggedClass`, branded IDs,
> `Schema.TaggedErrorClass`, and deriving TypeScript types from schemas instead of hand-writing parallel types.

## 1. Anatomy — the file set

Split by responsibility. Names like `client`/`dispatch`/`persistence`/`oauth` are Slack-specific, not required.

| File                                         | Owns                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `x.service.ts`                               | the `Context.Service` **shape** + the **live layer** (`Layer.effect`)                   |
| `x.errors.ts`                                | all `Schema.TaggedErrorClass` classes + the internal/public error unions                |
| `x.types.ts`                                 | domain types (and optionally the service shape — both fine)                             |
| `x.client.ts`                                | the external adapter: wraps the SDK/HTTP, emits typed errors, owns the SDK-error mapper |
| `x.persistence.ts`                           | DB operations (Drizzle), each mapping driver errors to a tagged error                   |
| `x.<concern>.ts`                             | further sub-effects (dispatch/oauth/…) by responsibility                                |
| pure helpers (`format.ts`, `classify.ts`, …) | functional core — no I/O, no deps                                                       |

A small service may stay in one file. Split when it spans external-call + persistence + orchestration.

## 2. Deep modules

- **Small, domain-shaped surface.** Few methods; each input/output a domain type; **each method's error union
  is small, caller-actionable, and distinct from (smaller than) the internal vocabulary.** Slack: 8 internal
  `SlackProviderError` tags → public `SlackConnectionError` (4); `dispatch*` advertises `never`.
- **The caller must not know the module's internals.** A service resolves the data that is its _own_ concern
  rather than making the caller fetch and pass it. `listChannels({ organizationId })` resolves the bot token
  internally; a shallow `listChannels({ botToken })` leaks an internal.
- **But accept the domain inputs the caller legitimately holds, as named types.** Not "pass a `taskId` and
  look it up" — if callers have the `Task`, take a `Task`. Don't destructure its fields into the signature.
- **IDs:** branded IDs are the default for identity values. Use raw `string` only for non-identity text,
  provider-owned names, opaque external strings, or display values. Always pass IDs in named input objects
  (`{ organizationId }`) — never positional bare strings or same-typed positional args.
- **Decision rule:** _to produce this argument, would the caller have to know how the module works inside?_
  Yes → the module resolves it. No, it's a value they already hold → accept it as its domain type.
- **Deletion test:** removing the module must _spread_ complexity to callers, not erase it. Shallow tells: a
  1:1 SDK/table mirror; an interface that makes callers supply internals.

## 3. Errors

- **`Schema.TaggedErrorClass`** for every expected failure — stable tag, structured safe fields, optional
  `cause: Schema.Defect()`. Derive operation/status/id field types from schemas, not duplicate TypeScript types.
- **Two tiers.** Internal: the rich vocabulary of everything that can break (transport + API-body + persistence).
  Public: a small union of caller-actionable outcomes per method.
- **Model the decision, not the status.** `SlackNeedsReauthError`, `retryable`, `…Unavailable`, `AlreadyRequested`
  — not `ServerError`/`RateLimitError` status buckets. Never make a caller string-match a message to recover a
  distinction (the workos `'already invited'` smell).
- **Classify in the channel.** Transform the **error channel** with `catchTags`/`mapError` on typed errors —
  not a plain `(cause: unknown) => Error`. Prefer SDKs that already emit typed errors (`@humanlayer/effect-slack`).
- **Throwing SDKs** (the one exception): `Effect.tryPromise({ try, catch })` where `catch` delegates to **one**
  per-adapter `mapSdkErrorToEffectError(cause) => TaggedError`. Centralized — no scattered cause-inspection,
  no `instanceof`, no `(x as any).status` sprinkled around.
- **Banned:** `instanceof` in Effect code; `error._tag === '…'` equality; raw/`unknown` errors leaked to callers;
  errors carried as values (`{ ok: false, error: string }`). Aggregate with `Effect.result` → `Result<A, E>`.

## 4. Effect purity & dependencies

- **Declare service deps in `R`** (`yield* PostgresDb`, `yield* WorkosService`). Never pass a service/layer as a
  function argument (`(workos) => Layer.succeed(...)` is wrong).
- **Effect-needs-effect → compose with the pipe pattern** (`.pipe` / `yield*` / `flatMap`), not by passing
  effects around. Passing an effect/capability is a rare, justified exception.
- The functional core (parsers, formatting, decisions) is pure — no I/O, no logger, no ambient time/randomness.
  The imperative shell (the layer + adapters) sequences effects, does I/O, classifies failures, observes.

## 5. Observability — three channels

- **Spans (required).** One `Effect.withSpan('service_name.operation', { attributes })` per **public method**,
  plus **child spans for sub-effects that do I/O or are expensive**, **none for pure helpers**. Add safe context
  with `Effect.annotateCurrentSpan({...})`. Naming: `snake_case` `domain.operation` (`slack.list_channels`).
  Spans live **inside** the service, not only at the orpc handler.
- **Logs.** `Effect.logError` (+ `logDebug`/`logInfo` for notable events) with `Effect.annotateLogs({...})`.
  Reuse the **same attribute object** for logs and spans.
- **Sentry — actionable or unexpected only.** `Sentry.captureException(error, { tags: { error_type }, extra })`
  for integration/transport breakage, defects (via `catchCause`), and anything degrading a capability a human
  should see. **Not** pure control-flow / input validation (`SlackNotConnectedError`, `…ValidationError`).
- **Capture before you narrow or swallow.** `tapError(log)` + `tapError(Sentry)` on the **raw** error _before_
  `catchTags`. Best-effort work captures, then swallows — never swallows silently. Top-level nets use
  `catchCause` (catches defects too), not just `catchTag`.
- **Safe fields only.** Domain IDs, operation, provider, tags, `has_access_token: Boolean(...)`. Secrets are
  `Redacted` and never logged/spanned.

## 6. Config & secrets

- Load **all env vars and secrets via Effect `Config`** (`Config.string` / `Config.redacted` / `Config.url`,
  `Config.withDefault(...)`) inside the layer's `Effect.gen`. No `process.env` in service logic.
- Secrets are `Redacted` end-to-end; `Redacted.value(...)` **only at the adapter edge** making the call.
- `Config`-based loading is what makes the service testable without env (tests inject `ConfigProvider`).

## 7. Boundaries & DB rows

- **Parse untrusted boundaries into domain types** at the adapter edge (HTTP/SDK/JSON/webhooks/user input).
  Slack maps raw `conversations.list` objects → `SlackChannel`. Parsing of inbound request bodies happens at
  the oRPC/webhook entrypoint; the service receives already-parsed domain inputs.
- **Schema-first domain modeling.** Domain records, commands, durable events, and discriminated unions should be
  modeled as schemas first (`Schema.TaggedClass` for tagged variants; branded schemas for IDs), then exported as
  `type X = typeof X.Type`. Avoid hand-written object types that duplicate schema fields.
- **DB rows: scalar trust, jsonb parse.** Trust Drizzle `$inferSelect` types for straightforward scalar columns
  (Postgres enforces them). **Parse `jsonb`** — Postgres does not enforce jsonb shape — with the existing **Zod**
  schemas (`@codelayer/db/zodschemas/*`, `drizzle-zod` select schemas). No Effect Schema bridging.
- **Never return a raw `$inferSelect` row across the public interface** — project to a domain type
  (Slack returns `SlackConnectionStatus`, not the integration row).
- `parseX` / `makeX` / `isX` naming (avoid `validateX`); no generic `isRecord`/`isObject` guards; no `as T` on
  decoded JSON or rows.

## 8. Async & workflows

- **Bounded concurrency** for unbounded/fan-out work (`Effect.forEach(xs, f, { concurrency })`); start independent
  work together rather than awaiting in a loop.
- **Idempotency** on retried creates (idempotency keys; `onConflictDoNothing` claims). **Atomic transition guards**
  for lifecycle writes (the Slack thread-claim via `acquireUseRelease`). Do **not** hold a DB transaction open
  across a network call.
- **Best-effort / `Effect<void, never>`** is the right shape for fan-out/notification side-effects where one
  failure must not fail the caller: capture (log + Sentry) then swallow; surface a typed error only when the
  caller can act on it. Codify Slack's `absorbDeliveryFailure` + `catchCause`.
- No floating/unsupervised effects.

## 9. Testing — real-seam layers with `@effect/vitest`

- **Always `@effect/vitest`.** `import { describe, it } from '@effect/vitest'`; keep `expect`/`beforeAll`/`afterAll`
  from `vitest`. The Slack `ManagedRuntime` + plain-vitest tests are **legacy** — write new tests with `it.effect`.
- **`it.effect('…', () => Effect.gen(function*(){ … }).pipe(Effect.provide(layer)))`.** No `ManagedRuntime`, no
  manual `runPromise`/`dispose`.
- **Build the layer** behind a `makeLayer(opts)` factory:
  `Layer.provideMerge(ServiceLive, Layer.mergeAll(PostgresDbLive(db), …fakes, ConfigProvider…))`.
- **Substitute each dep by category:** real ephemeral DB (`PostgresDbLive(db)` + `createTestDb`) for persistence
  behavior; a hand-fake `PostgresDb` layer for pure-logic-over-DB; `Layer.succeed(Service, {...})` recording-store
  fakes for true externals (unused methods `Effect.die('… not used')`); a fake `HttpClient` layer or loopback
  server for transport; `ConfigProvider.fromUnknown({...})` for config.
- **Expose a `…Base` layer** that leaves the external transport unprovided, so tests can inject a fake `HttpClient`.
- **Assert on both** the returned value / narrowed error **and** real side-effect end-state (DB rows via
  `Effect.promise(() => db.select()…)`, recording-store contents).
- **Banned:** `vi.mock`, `vi.spyOn`, module patching, method spies. If a dep can't be swapped via a layer, the
  module is wrong (hidden/ambient/arg-passed) — fix the module, not the test.

## 10. TypeScript contracts (must-haves)

No `any`, no `!`, no unjustified `as` (escape hatches are local, behind precise interfaces, with a `SAFETY:`
comment + lint-disable reason). `readonly` by default. `??` not `||` for "absent" defaults; no `filter(Boolean)`.
`import type` for type-only imports; no barrels; JSDoc on exports. Guard clauses (no `else` after `return`).
`Map`/`Set` for dynamic keyed collections. Precise file names — no `utils.ts`/`helpers.ts` dumping grounds.

## Review checklist

- [ ] Public surface small, domain-shaped; per-method error union narrow + distinct from internal.
- [ ] No `$inferSelect` row, `any`, or `unknown` across the public seam.
- [ ] Errors are `Schema.TaggedErrorClass`, model caller actions; classified in-channel; **one** SDK-error mapper.
- [ ] Capture (log + Sentry) happens on the raw error **before** narrowing/swallowing; `catchCause` at top nets.
- [ ] `Effect.withSpan` on every public method; safe annotations; secrets `Redacted`.
- [ ] All deps in `R`; no service/layer/effect passed as an argument; no errors-as-values.
- [ ] Config via `Config.*`; secrets `Redacted`, unwrapped only at the edge.
- [ ] jsonb parsed with Zod; scalar columns trusted.
- [ ] Tests use `@effect/vitest` `it.effect` + `Effect.provide(layer)`; real seams; no `vi.mock`/`vi.spyOn`;
      assert value **and** persisted end-state.
- [ ] No `instanceof`, no `error._tag === '…'`, no plain `(cause) => Error` classifiers.
