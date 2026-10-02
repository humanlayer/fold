# Vendored lint tooling

Fold owns and maintains the tooling under `tools/`. It is formatted with the repository's oxfmt settings but is
excluded from lint.

| Path                                 | Source                                                                                                                                                                                                                                                                       | Run by         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `tools/oxlint/anti-slop`             | [K-Mistele/anti-slop](https://github.com/K-Mistele/anti-slop) `src/` at `3abfdfb` (fork of dmmulroy/anti-slop), plus the local `no-conditional-empty-{object,array}-spread` rules and `Schema.tag`/`Schema.tagDefaultOmit` fields allowed by `no-manual-tagged-construction` | `bun run lint` |
| `tools/oxlint/automation`            | [typeonce-dev/ai-automation](https://github.com/typeonce-dev/ai-automation/tree/0bca096fe6fe9878cd15303a623dd2cd85915ddd/rules/oxlint/src) via humanlayer/channels `e499a74`                                                                                                 | `bun run lint` |
| `tools/oxlint/import-extensions.mjs` | humanlayer/channels `e499a74`                                                                                                                                                                                                                                                | `bun run lint` |
| `tools/typed`                        | typeonce-dev/ai-automation `0bca096` via humanlayer/channels `e499a74`                                                                                                                                                                                                       | `bun run lint` |

The `automation` rules that Fold used before this import (`no-ambient-nondeterminism`, `no-disable-validation`,
`no-manual-tag-comparison`, `no-manual-tagged-construction`, `no-service-option`,
`no-shadowed-standard-array-static`, `no-silent-error-swallow`, `prefer-effect-match`,
`prefer-option-from-nullable`, `prefer-tagged-error-handling`) are Fold adaptations; the rest are upstream
source. `tools/typed/src/engine.ts` sets `followSymbolicLinks: false` so workspace symlink cycles in
`node_modules` do not break source exclusion.

Keep `oxlint`, `@oxlint/plugins`, `oxlint-tsgolint`, and `@effect/tsgo` on versions `@effect/tsgo` lists as
supported; `prepare` patches oxlint with the Effect rules used by the `recommended` preset.

## Rules not yet enabled

These rules are vendored but off because Fold code still violates them. Counts exclude TUI code, which keeps
its exemption in `.oxlintrc.jsonc`.

| Rule                                         | Production | Tests |
| -------------------------------------------- | ---------- | ----- |
| `automation/private-function-prefix`         | 406        | 161   |
| `automation/no-multiple-function-params`     | 283        | 59    |
| `automation/no-single-use-private-functions` | 292        | 41    |
| `automation/no-optional-function-parameters` | 104        | 22    |
| `automation/no-effect-asvoid`                | 15         | 1     |

`anti-slop/no-comments`, `automation/no-comments`, and `automation/no-reexport-only-modules` (it only flags package
entrypoints) are intentionally off. Tests are exempt from `automation/no-global-json`, the type-assertion rules,
`no-try-catch`, `no-typeof-object`, `no-runtime-typeof`, `no-unknown-parameters`, and `no-unsafe-dictionary-type`.
`scripts/` and `packages/fold/postinstall.mjs` are not linted.
The React, XState, Tailwind, and API-layer `automation` rules do not apply to Fold.
