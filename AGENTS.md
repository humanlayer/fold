# fold

Bun monorepo. Packages live in `packages/*` and run TypeScript directly (no build step).

## Stack

- **Runtime / package manager:** Bun (`bun@1.3.14`)
- **Framework:** Effect **v4** (`4.0.0-rc.109`)
- **Testing:** Vitest + `@effect/vitest`
- **Lint / format:** oxlint + oxfmt (120 col, no semicolons)
- **Effect editor tooling:** `@effect/tsgo` with the `@effect/language-service` TS plugin. `tsc` is patched for
  build-time Effect diagnostics via the `prepare` script (`effect-tsgo patch --typescript`).

## Commands

- `bun install` — install deps (also patches TypeScript for Effect diagnostics)
- `bun run test` / `bun run test:watch` — run tests
- `bun run typecheck` — typecheck every package
- `bun run lint` / `bun run lint:fix` — oxlint
- `bun run format` / `bun run format:check` — oxfmt

## Dependency versions

Shared versions are pinned once in the Bun **catalog** (`workspaces.catalog` in `package.json`);
packages reference them with `"<pkg>": "catalog:"`. Bump the version in the catalog, not per package.

## Shared packages

- `packages/effect-branded-id` (`@humanlayer/effect-branded-id`) provides Effect schemas and
  generators for type-safe, prefixed CUID2 identifiers.
- `packages/vitest-config` (`@humanlayer/fold-vitest-config`) is the internal shared Vitest config.

## Effect v4 source (read this, not v3 docs)

This repo targets **Effect v4 (release candidate)** — its API differs from the widely-documented v3. The v4
source is the `effect` repo:

- In Riptide worktree tasks it is checked out as a sibling at **`../effect`**.
- Locally it lives at **`~/projects/effect`**.

When unsure about a v4 API, read the source there rather than relying on v3 knowledge or docs.
