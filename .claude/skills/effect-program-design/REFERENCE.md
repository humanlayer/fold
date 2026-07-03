# Effect Program Design — Reference

Annotated skeleton, copy-paste patterns, and the anti-pattern catalog. Canonical real implementation:
`apps/riptide-api/src/effects/services/slack/`. Good runner-up: `access-request/` (note: it also contains
anti-patterns — see the catalog). Foils to avoid: `workos/`, `resend/`, `stripe/`, `s3/`.

---

## File skeleton

### `widget.errors.ts` — tagged errors, two-tier unions

```ts
import { Schema } from 'effect'

import { OrganizationId } from './widget.ids'

// Internal vocabulary: everything that can break at the boundary.
export class WidgetTokenRevokedError extends Schema.TaggedErrorClass<WidgetTokenRevokedError>()(
  'WidgetTokenRevokedError',
  { cause: Schema.optional(Schema.Defect()) },
) {}
export class WidgetRateLimitError extends Schema.TaggedErrorClass<WidgetRateLimitError>()(
  'WidgetRateLimitError',
  { retryAfterMs: Schema.optional(Schema.Number), cause: Schema.optional(Schema.Defect()) },
) {}
export class WidgetApiUnavailableError extends Schema.TaggedErrorClass<WidgetApiUnavailableError>()(
  'WidgetApiUnavailableError',
  { cause: Schema.optional(Schema.Defect()) },
) {}
export class WidgetUnexpectedResponseError extends Schema.TaggedErrorClass<WidgetUnexpectedResponseError>()(
  'WidgetUnexpectedResponseError',
  { code: Schema.optional(Schema.String), cause: Schema.optional(Schema.Defect()) },
) {}

// Public vocabulary: small, caller-actionable. Models the decision, not the HTTP status.
export class WidgetNotConnectedError extends Schema.TaggedErrorClass<WidgetNotConnectedError>()(
  'WidgetNotConnectedError',
  { organizationId: OrganizationId },
) {}
export class WidgetNeedsReauthError extends Schema.TaggedErrorClass<WidgetNeedsReauthError>()(
  'WidgetNeedsReauthError',
  { organizationId: OrganizationId, lastErrorCode: Schema.optional(Schema.String) },
) {}
export class WidgetUnavailableError extends Schema.TaggedErrorClass<WidgetUnavailableError>()(
  'WidgetUnavailableError',
  { cause: Schema.optional(Schema.Defect()) },
) {}

export type WidgetProviderError =
  | WidgetTokenRevokedError | WidgetRateLimitError | WidgetApiUnavailableError | WidgetUnexpectedResponseError
```

### `widget.types.ts` — domain types + the service shape

```ts
import type { Effect } from 'effect'
import type { WidgetNeedsReauthError, WidgetNotConnectedError, WidgetUnavailableError } from './widget.errors'

export type Widget = { id: string; name: string }          // domain type — never the SDK/row shape

export type WidgetServiceShape = {
  // Narrow input (named object), narrow per-method public error union.
  listWidgets: (input: { organizationId: string }) => Effect.Effect<
    readonly Widget[],
    WidgetNotConnectedError | WidgetNeedsReauthError | WidgetUnavailableError
  >
  // Best-effort fan-out: structurally cannot fail.
  notify: (input: { organizationId: string; widgetId: string }) => Effect.Effect<void, never>
}
```

### `widget.service.ts` — shape + live layer (capture-then-narrow lives here)

```ts
import { Config, Context, Effect, Layer, Redacted } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'

import { Sentry } from '../../../instrument'
import { PostgresDb } from '../postgres/postgres-db.service'
import { makeWidgetClient } from './widget.client'
import { WidgetNeedsReauthError, WidgetUnavailableError } from './widget.errors'
import { requireWidgetConnection, markNeedsReauth } from './widget.persistence'
import type { WidgetServiceShape } from './widget.types'

export class WidgetService extends Context.Service<WidgetService, WidgetServiceShape>()('WidgetService') {}

export const WidgetServiceLiveBase = Layer.effect(
  WidgetService,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted('WIDGET_API_KEY')          // secrets via Config + Redacted
    const baseUrl = yield* Config.string('WIDGET_API_BASE_URL').pipe(Config.withDefault('https://api.widget.com'))
    const httpClient = yield* HttpClient.HttpClient                  // injected — substitutable in tests
    const postgres = yield* PostgresDb                               // dep declared in R

    const client = makeWidgetClient({ httpClient, config: { apiKey, baseUrl } })

    return {
      listWidgets: ({ organizationId }) =>
        Effect.gen(function* () {
          const conn = yield* requireWidgetConnection(organizationId) // module resolves its own internal (token)
          return yield* client.list(Redacted.make(conn.access_token))
        }).pipe(
          Effect.withSpan('widget.list_widgets', { attributes: { organization_id: organizationId } }),
          // CAPTURE (raw) BEFORE NARROW:
          Effect.tapError((error) => Effect.logError(error)),
          Effect.tapError((error) => Effect.sync(() => Sentry.captureException(error))),
          // NARROW internal → public, and self-heal:
          Effect.catchTag(['WidgetTokenRevokedError'], (error) =>
            markNeedsReauth(organizationId, error._tag).pipe(
              Effect.flatMap(() => Effect.fail(new WidgetNeedsReauthError({ organizationId, lastErrorCode: error._tag }))),
            ),
          ),
          Effect.catchTags({
            WidgetRateLimitError: (cause) => Effect.fail(new WidgetUnavailableError({ cause })),
            WidgetApiUnavailableError: (cause) => Effect.fail(new WidgetUnavailableError({ cause })),
            WidgetUnexpectedResponseError: (cause) => Effect.fail(new WidgetUnavailableError({ cause })),
          }),
          Effect.provideService(PostgresDb, postgres),
        ),

      notify: (input) =>
        notifyWidget(input).pipe(   // see widget.notify.ts — best-effort, returns Effect<void, never>
          Effect.provideService(PostgresDb, postgres),
        ),
    }
  }),
)

// Expose the transport unprovided as the Base; provide it for production.
export const WidgetServiceLive = WidgetServiceLiveBase.pipe(Layer.provide(HttpClient.layer))
```

### `widget.client.ts` — external adapter, the ONE SDK-error mapper

```ts
import { Effect, Redacted } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'

import { Sentry } from '../../../instrument'
import { WidgetApiUnavailableError, WidgetRateLimitError, WidgetTokenRevokedError, WidgetUnexpectedResponseError } from './widget.errors'
import type { WidgetProviderError } from './widget.types'

// The single per-adapter mapper. The ONLY place that inspects a thrown cause.
// Prefer Schema.decodeUnknown / safe property access over instanceof.
const mapSdkErrorToEffectError = (cause: unknown): WidgetProviderError => {
  const status = typeof cause === 'object' && cause !== null ? (cause as { status?: number }).status : undefined
  if (status === 401) return new WidgetTokenRevokedError({ cause })
  if (status === 429) return new WidgetRateLimitError({ cause })
  if (status !== undefined && status >= 500) return new WidgetApiUnavailableError({ cause })
  return new WidgetUnexpectedResponseError({ cause })
}

export const makeWidgetClient = (deps: { httpClient: HttpClient.HttpClient; config: { apiKey: Redacted.Redacted<string>; baseUrl: string } }) => ({
  list: (token: Redacted.Redacted<string>) =>
    Effect.tryPromise({
      try: () => callWidgetApi(deps, token),            // throwing SDK
      catch: mapSdkErrorToEffectError,                  // throwing boundary: ok, but only here, only this fn
    }).pipe(
      Effect.tapError((e) => Effect.logError('Widget API failed', e)),
      Effect.tapError((e) => Effect.sync(() => Sentry.captureException(e))),
      Effect.withSpan('widget.api.list'),               // child span on the I/O sub-effect
    ),
})
```

### `widget.persistence.ts` — map driver errors at the seam

```ts
export const requireWidgetConnection = (organizationId: string) =>
  Effect.gen(function* () {
    const pg = yield* PostgresDb
    return yield* pg.query(pg.client.select().from(widgetConnections).where(eq(widgetConnections.organization_id, organizationId)).limit(1)).pipe(
      Effect.mapError((cause) => new WidgetUnavailableError({ cause })),
      Effect.flatMap(([row]) =>
        !row ? Effect.fail(new WidgetNotConnectedError({ organizationId }))
        : row.needs_reauth ? Effect.fail(new WidgetNeedsReauthError({ organizationId, lastErrorCode: row.last_error_code ?? undefined }))
        : Effect.succeed(row),   // trust scalar columns; parse jsonb columns with the Zod schema before returning
      ),
    )
  })
```

### Best-effort fan-out (`Effect<void, never>`)

```ts
const notifyWidget = (input: { organizationId: string; widgetId: string }): Effect.Effect<void, never, PostgresDb> =>
  Effect.gen(function* () { /* … fan out … */ }).pipe(
    Effect.catchCause((cause) =>                          // catches defects too
      Effect.logError('Widget notify failed', cause).pipe(
        Effect.andThen(Effect.sync(() => Sentry.captureException(cause, { tags: { error_type: 'widget_notify_failure' }, extra: input }))),
      ),
    ),
  )
```

---

## Test skeleton — `@effect/vitest`

```ts
import { describe, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer } from 'effect'
import { beforeAll, afterAll, expect } from 'vitest'

import { WidgetService, WidgetServiceLiveBase } from '../../src/effects/services/widget/widget.service'
import { PostgresDbLive } from '../../src/effects/services/postgres/postgres-db.service'
import { createTestDb } from '../utils/test-db'
import { requireExternalTestServices } from '../utils/external-test-services'

await requireExternalTestServices()

describe('WidgetService.listWidgets', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: (() => Promise<void>) | undefined
  beforeAll(async () => { const t = await createTestDb('widget'); db = t.db; cleanup = t.cleanup }, 60000)
  afterAll(async () => { await cleanup?.() }, 30000)

  const configLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({ WIDGET_API_KEY: 'k', WIDGET_API_BASE_URL: 'https://widget.test' }))
  const fakeHttp = Layer.succeed(/* HttpClient.HttpClient */ undefined as never, /* canned responses */ undefined as never)
  const makeLayer = () => Layer.provideMerge(WidgetServiceLiveBase, Layer.mergeAll(PostgresDbLive(db), configLayer, fakeHttp))

  it.effect('returns widgets through the public interface', () =>
    Effect.gen(function* () {
      const svc = yield* WidgetService
      const widgets = yield* svc.listWidgets({ organizationId: 'org-1' })
      expect(widgets).toEqual([{ id: 'w1', name: 'one' }])
      // also assert real DB end-state via Effect.promise(() => db.select()…)
    }).pipe(Effect.provide(makeLayer())),
  )
})
```

Dependency category → seam: real ephemeral DB (`PostgresDbLive(db)`) for persistence behavior; hand-fake
`PostgresDb` layer for pure-logic; `Layer.succeed(Service, {…})` recording-store fakes for true externals
(unused methods `Effect.die('… not used')`); fake `HttpClient`/loopback server for transport.

---

## Anti-pattern catalog (in-repo line refs)

| Anti-pattern | Where (foil) | Fix |
|---|---|---|
| `instanceof` in Effect code | workos.service.ts:62; resend.service.ts:89; access-request.service.ts:139,335 | `catchTag` / `Schema` |
| classify-then-silent (no capture) | resend.service.ts; workos.service.ts (whole) | `tapError` → log + Sentry |
| one wide error union for every method | workos `WorkosError`×all; resend `ResendError`×all | narrow per method |
| status-bucket errors vs caller-action | workos.service.ts:61-84; resend.service.ts:76-114 | model the decision |
| caller string-matches a message | access-request.service.ts:335 (`'already invited'`) | model it as a tag |
| `unknown`/`any` across the seam | resend.service.ts:53 (`getAutomation: …unknown`); `(client as any)` | parse to domain type |
| errors-as-values | access-request-internal.ts:38 (`NotifyResult.error: string`) | keep typed in the channel |
| dep/layer/effect passed as arg | workos-config.service.ts:11 (`(workos) => Layer.succeed`) | declare in `R` |
| no spans | slack/*, workos, resend, stripe, s3 | `withSpan` + `annotateCurrentSpan` |
| `Effect.orDie` hiding init failure | s3.service.ts:45 | typed error + capture |
| module mocks / method spies | (any test) | swap layers at real seams |
| `ManagedRuntime` + plain vitest for a new test | slack-*.vi.test.ts (legacy) | `@effect/vitest` `it.effect` |

## Specimens

- **GOLD — `slack/`**: deep module; internal `SlackProviderError` (8) → public `SlackConnectionError` (4);
  capture-then-narrow at the boundary; `dispatch*` is `Effect<void, never>` with `absorbDeliveryFailure` +
  `catchCause`; `Config`/`Redacted`; decomposed by responsibility. (Tests are legacy `ManagedRuntime`.)
- **MIXED — `access-request/`**: good `it.effect` tests, retryable SQLSTATE classification, boundary narrowing —
  but also `instanceof`, errors-as-values, message string-matching. Not an exemplar.
- **FOILS — `workos/` `resend/` `stripe/`**: shallow SDK wrappers, classify-then-silent, wide unions, no spans.
  **`s3/`**: worst — no tagged errors, raw `Error`, `Effect.orDie`, no observability.
