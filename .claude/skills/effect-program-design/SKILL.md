---
name: effect-program-design
description: >-
    Design, write, review, and test Fold's Effect v4 programs: descriptor-facing public APIs, deep services and
    layers, schemas, tagged failures, resource ownership, concurrency, and real-seam Effect tests. Use for Fold
    services, adapters, providers, event logs, session workflows, and Effect-based code review.
---

# Fold Effect Program Design

Build deep Fold modules: a small, domain-shaped public interface hides descriptor lowering, service wiring, provider
details, persistence, resource ownership, and workflow coordination. Keep expected failures in Effect's error channel,
dependencies in `R`, resources in scopes, and external values at explicit schema boundaries.

Fold is an Effect v4 (`4.0.0-rc.109`) Bun monorepo. Read the installed declarations first; when they do not settle an
API, read `~/projects/effect`, not Effect v3 documentation or examples.

## Fold's architecture

- **Public Fold APIs are descriptor-facing.** Hosts use `defineAgent`, model descriptors, tool descriptors, and
  event-log descriptors without learning `Layer`, `Toolkit`, or runtime wiring. See `README.md` and
  `packages/fold-core/src/Api/Provisioning.ts`.
- **Provisioning owns lowering.** The provisioner turns descriptors into the required services and layers once per
  runtime/session. Do not make callers build or pass Fold's internal clients, layers, toolsets, or runtime services.
- **Services are internal capabilities.** Use `Context.Service` and `Layer` where a capability varies by runtime,
  implementation, or test seam. One implementation is enough when the seam is valuable for real tests.
- **Event schemas are durable contracts.** Model persisted and wire-visible log entries with `Schema.TaggedStruct` and
  `Schema.Union`; decode before projecting or dispatching. See `packages/fold-core/src/EventLog/Schemas.ts`.

## The defaults

1. **Deep modules.** A module's interface is the cost; hidden behavior is the benefit. A caller supplies the domain
   values it holds, not credentials, provider clients, decoded rows, layers, or other internals.
2. **Effects retain their channels.** Expected failure stays in `E`; dependencies stay in `R`; resources have an
   owning scope. Do not pass errors, services, layers, or effects around as ordinary data just to compose them later.
3. **Typed failures recover in-channel.** Classify an untrusted/throwing boundary once, then use `Effect.catchTag` or
   `Effect.catchTags` to recover or narrow. Do not recover typed failures with `instanceof` or manual `_tag` checks.
4. **Normal tagged data dispatches explicitly.** For decoded or otherwise trusted union values, use `Predicate` for
   reusable narrowing and `Match` for complete transformations. See `PREDICATE-MATCH.md`.
5. **Schemas parse boundaries.** Decode JSON, files, provider payloads, host input, and durable records at their edge.
   Do not cast or ad hoc-narrow unknown data through the core.
6. **Tests cross real seams.** Test services through their public interface with `@effect/vitest` and substitute layers
   or real test adapters. Do not use `vi.mock`, module patching, or method spies.

## Module depth and seams

- Give public operations named domain inputs and outputs. A descriptor API should hide the provider/layer graph it
  needs to realize the descriptor.
- Use the deletion test: deleting a useful module should spread its orchestration and invariants across callers, not
  simply delete a pass-through.
- Keep pure domain decisions, projections, and formatting separate from the I/O shell. Pure helpers accept and return
  domain values; layers/adapters sequence Effects and own I/O.
- Do not add a wrapper solely to mirror an SDK or data structure. A module earns its seam by concentrating meaningful
  lifecycle, policy, parsing, or orchestration.
- Do not make all dependencies ordinary parameters. Runtime-varying capabilities belong in Effect's environment; pure
  values legitimately held by the caller stay explicit inputs.

## Services, layers, and resources

- Prefer `Context.Service` for an application capability and `Layer.effect` or `Layer.scoped` for its implementation.
  Small capabilities may collocate shape, tag, and live layer; split an external adapter, persistence, or workflow
  only when that separation improves locality.
- Dependencies normally remain ambient in `R`. Yield them where the operation needs them rather than forwarding them
  through public signatures.
- Build runtime-specific layer graphs at the provisioner/facade seam. Fold's agent provisioner owns memo-map and
  scope semantics; callers do not recreate that graph.
- Acquire resources in a scope and make background work supervised/owned. Bound concurrency for unbounded fan-out and
  keep external calls outside authoritative transactions.
- Use `Effect.fn` or `Effect.withSpan` for meaningful public or I/O operation boundaries when observability is
  configured. Add safe context only; never log secrets or unrestricted provider payloads.

## Errors and boundaries

- Model expected failures as tagged errors with fields a caller can use. `Data.TaggedError` is appropriate for an
  internal failure; use a schema-backed tagged error when the error itself crosses an encoded boundary.
- Wrap a throwing SDK or native API once at its adapter edge with `Effect.try` or `Effect.tryPromise`. Its `catch`
  maps the unknown cause into the module's typed error vocabulary. Do not repeat provider-specific inspection in
  callers.
- Preserve rich internal failures until the module boundary, then narrow to the small set of outcomes callers can
  actually act on. A fallback is only correct when it is part of the operation's contract.
- Capture actionable or unexpected failures with the repository's configured logging/observability before swallowing
  or narrowing them. Do not add Sentry or other product-specific dependencies unless Fold provides and configures one.
- Use `catchCause` only for a deliberate top-level safety net that must include defects, such as a best-effort
  operation. It must make the failure observable before it is swallowed.

## Schema and domain data

- Use `Schema.Struct` for ordinary records and `Schema.TaggedStruct` plus `Schema.Union` for encoded tagged variants.
  Derive the TypeScript type from the schema with `typeof X.Type`.
- Use `Schema.Literals` for closed scalar vocabularies. Branded IDs are valuable where Fold must prevent
  same-typed identity mix-ups, but do not introduce brands by default without a concrete boundary or misuse risk.
- Use `Schema.optionalKey`, `Schema.optional`, and `Schema.NullOr` to preserve the distinction between absent,
  `undefined`, and `null` values.
- Decode untrusted encoded values with `Schema.decodeUnknownEffect`; use `make`/`makeEffect` only for trusted
  type-side construction. Do not cast decoded JSON.
- Keep schemas that define durable log data backward compatible. Add an entry schema/version and upcast at the decode
  boundary instead of mutating an incompatible persisted format.

## Predicate and Match

The error channel and ordinary tagged values require different tools:

- Use `Effect.catchTag` / `Effect.catchTags` for typed errors in `Effect<A, E, R>`.
- Use `Predicate.isTagged` for a reusable one-tag guard or a named multi-tag refinement used by `find`, `filter`, or
  a guard clause.
- Use `Match.type<T>()` and `Match.tagsExhaustive` for a reusable transformation over a Fold-owned closed union.
  Use `Match.value(value)` for a one-off dispatch.
- Keep a simple direct `_tag` guard in a local stateful loop when a matcher or extracted predicate would add ceremony.
  Do not mechanically replace every conditional. Repeated comparisons and complete domain transformations should not
  drift across ad hoc conditionals.
- Neither `Predicate` nor `Match` validates an unknown provider/file/JSON value. Decode it first.

Read `PREDICATE-MATCH.md` before writing or reviewing tagged normal-value control flow.

## Tests

- Use `@effect/vitest` and `it.effect`; provide the service/layer graph to the program under test.
- Substitute an external provider, filesystem, clock, or other true boundary with a narrow fake Effect layer. Use real
  ephemeral infrastructure when behavior depends on its constraints or persistence semantics.
- Prefer deterministic `TestClock`, `Deferred`, `Queue`, `Latch`, and `Ref` coordination over sleeps and timing
  races.
- Assert both the returned value/error and the relevant observable end state: durable entries, emitted events, files,
  requests recorded by a fake, or released resources.
- A fake should fail loudly for unexpected methods. If a dependency cannot be replaced at a layer seam, improve the
  module boundary rather than reaching for a module mock.

## References

- `PREDICATE-MATCH.md` for tagged normal-value dispatch.
- `SCHEMA-DOMAIN-PATTERNS.md` for Fold schema, durable-data, and error-model choices.
- `REFERENCE.md` for canonical Fold modules and the expected service/layer shapes.
- `codebase-design` for shared vocabulary on depth, interface, seam, adapter, leverage, and locality.

## Review checklist

- [ ] The public interface is small, domain-shaped, and hides Fold's descriptor-lowering and runtime wiring.
- [ ] Expected failures remain typed in `E`; dependencies remain declared in `R`; resources have an owner.
- [ ] Unknown data is decoded at the edge and raw provider/file data does not leak through a public contract.
- [ ] Typed errors use `catchTag` / `catchTags`; ordinary trusted tags use `Predicate` / `Match` when appropriate.
- [ ] Fold-owned complete unions use an exhaustive transformation where a new variant must force a review.
- [ ] Provider calls, concurrency, retries, and resource lifetime are bounded and owned by the module that needs them.
- [ ] Tests use `@effect/vitest`, real seams, deterministic coordination, and no module mocks or spies.
