# Fold Effect Program Design Reference

These are Fold-native references. Follow the closest existing pattern instead of importing application-specific
conventions from another repository.

| Concern                            | Canonical Fold reference                                  | What it demonstrates                                                                 |
| ---------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Public API and descriptor lowering | `README.md`; `packages/fold-core/src/Api/Provisioning.ts` | Hosts define data descriptors; provisioning owns internal service/layer wiring.      |
| Service interface                  | `packages/fold-core/src/EventLog/EventLogService.ts`      | A small `Context.Service` surface for a session-scoped capability.                   |
| Durable tagged data                | `packages/fold-core/src/EventLog/Schemas.ts`              | `Schema.TaggedStruct`, `Schema.Union`, versioning, and decode-time compatibility.    |
| Provider/runtime ownership         | `packages/fold-core/src/Api/Provisioning.ts`              | Scope ownership, fresh memo maps, provider layers, and resource lifetime.            |
| Complete tagged dispatch           | `packages/fold-agent/src/Session/SessionLayout.ts`        | An exhaustive `Match` over a Fold-owned tagged union.                                |
| Focused tag guard                  | `packages/fold-core/src/Subagents/SubagentsLayer.ts`      | `Predicate.isTagged` guards over decoded log entries.                                |
| Pure projection policy             | `packages/fold-core/src/Compaction/CompactionEngine.ts`   | Pure projections and the distinction between simple loop guards and transformations. |

## Public Fold shape

Fold has two intentionally different interfaces:

1. A host-facing descriptor interface for agents, models, tools, and hooks. Hosts select EventLog backends
   through ordinary Layer composition; Session.open hides the internal runtime graph.
2. An internal Effect interface, where `Context.Service` tags and `Layer` implementations express capabilities,
   resource requirements, and replaceable test seams.

Keep the conversion in one direction at the facade/provisioning seam:

```text
host agent descriptors + ambient EventLog -> Session.open/provisioning -> running session
```

Do not expose internal provider-client or tool-runtime wiring. EventLog backend selection is deliberately
layer-native at the host boundary. Do not turn a runtime-varying capability into a global singleton.

## A small service seam

Use a service when callers need a capability rather than a data structure. The service describes what callers can do;
its layer owns how it does it.

```ts
import { Context } from 'effect'
import type { Effect, Stream } from 'effect'

export type EventLogService = {
	readonly append: (entry: LogEntryInput) => Effect.Effect<LogEntry, EventLogError>
	readonly entries: (fromSeq?: LogSeq) => Stream.Stream<LogEntry, EventLogError>
}

export class EventLog extends Context.Service<EventLog, EventLogService>()('fold/EventLog') {}
```

The layer may coordinate storage, validation, sequence allocation, subscriptions, and resource cleanup. None of
those details become arguments to `append` or `entries`.

## Provisioning owns layers and scopes

Provisioning is a deep module: it takes a small model/tool descriptor and returns a ready `AgentRuntime`. It owns the
details that must remain coordinated:

- a fresh `Layer.makeMemoMap` for an isolated provision;
- the caller's ambient `Scope`, so runtime resources release at the correct lifetime;
- the shared session services versus per-agent tool/runtime layers;
- provider-specific `LanguageModel` realization.

When adding a new descriptor field or provider, ask which side of this seam owns it. Host-visible policy belongs in
the descriptor. Runtime clients, layer composition, and release behavior belong in provisioning.

## Errors are not normal tagged values

For a typed provider or service failure, preserve the error channel and recover in it:

```ts
operation.pipe(
	Effect.catchTags({
		ProviderUnavailable: () => Effect.succeed(fallback),
		ProviderUnauthenticated: () => Effect.succeed(fallback),
	}),
)
```

For a decoded event/descriptor union, dispatch it as a normal value with `Predicate` or `Match`. Do not move an
Effect error into a normal union merely to match it, and do not use `Match` as a substitute for `catchTag`.

## Testing at a real seam

Write an `it.effect` program that acquires the public service and provides its dependencies as layers. Replace only
true externals such as an HTTP provider, filesystem, clock, or event-log adapter. Use a real implementation when the
behavior under test depends on durable storage or its constraints.

```ts
it.effect('records an entry through the public service', () =>
	Effect.gen(function* () {
		const eventLog = yield* EventLog
		const entry = yield* eventLog.append(input)
		expect(entry._tag).toBe('user-message')
		// Assert the observable adapter end state when the behavior promises one.
	}).pipe(Effect.provide(testLayer)),
)
```

No `vi.mock`, `vi.spyOn`, module patching, or sleep-based timing. If the behavior cannot be tested by providing a
layer, move the seam rather than patching the module under test.

EventLog resources belong to the host's acquisition scope, while internal session graphs use session-fresh memo
maps. Session.open adopts existing identity or initializes an empty log; it never rebuilds a supplied backend.
