# Vendored lint tooling

Fold owns and maintains the tooling under `tools/`. It is formatted with the repository's oxfmt settings but is
excluded from lint.

| Path                                 | Source                                                                                                                                                                            | Run by         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `tools/oxlint/anti-slop`             | [K-Mistele/anti-slop](https://github.com/K-Mistele/anti-slop) `src/` at `3abfdfb` (fork of dmmulroy/anti-slop), plus the local `no-conditional-empty-{object,array}-spread` rules | `bun run lint` |
| `tools/oxlint/automation`            | [typeonce-dev/ai-automation](https://github.com/typeonce-dev/ai-automation/tree/0bca096fe6fe9878cd15303a623dd2cd85915ddd/rules/oxlint/src) via humanlayer/channels `e499a74`      | `bun run lint` |
| `tools/oxlint/import-extensions.mjs` | humanlayer/channels `e499a74`                                                                                                                                                     | `bun run lint` |
| `tools/typed`                        | typeonce-dev/ai-automation `0bca096` via humanlayer/channels `e499a74`                                                                                                            | `bun run lint` |

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

| Rule                                                  | Production | Tests |
| ----------------------------------------------------- | ---------- | ----- |
| `automation/private-function-prefix`                  | 460        | 153   |
| `automation/no-single-use-private-functions`          | 327        | 42    |
| `automation/no-multiple-function-params`              | 294        | 54    |
| `automation/no-optional-function-parameters`          | 100        | 21    |
| `anti-slop/no-known-value-widening`                   | 95         | 10    |
| `anti-slop/no-runtime-typeof`                         | 68         | 11    |
| `automation/no-global-json`                           | 50         | 150   |
| `anti-slop-effect/no-manual-tagged-construction`      | 46         | 295   |
| `anti-slop/no-unknown-parameters`                     | 44         | 22    |
| `anti-slop/no-conditional-spread`                     | 37         | 3     |
| `anti-slop/no-unsafe-dictionary-type`                 | 33         | 4     |
| `anti-slop/no-conditional-empty-array-spread`         | 26         | 3     |
| `automation/no-try-catch`                             | 25         | 1     |
| `anti-slop-effect/no-service-constructor-imports`     | 22         | 8     |
| `automation/no-typeof-object`                         | 18         | 5     |
| `automation/no-effect-asvoid`                         | 15         | 1     |
| `anti-slop/no-reprovide-ambient-service`              | 13         | 0     |
| `automation/no-in-operator`                           | 12         | 6     |
| `automation/no-switch`                                | 12         | 0     |
| `anti-slop/no-unknown-returns`                        | 9          | 1     |
| `automation/no-reexport-only-modules`                 | 7          | 0     |
| `automation/no-type-assertion`                        | 5          | 5     |
| `automation/no-direct-fetch`                          | 5          | 0     |
| `anti-slop/no-shape-in-symbol-names`                  | 5          | 0     |
| `anti-slop/no-reflect-get`                            | 4          | 2     |
| `automation/no-banned-type-assertions`                | 1          | 3     |
| `anti-slop/no-chained-type-assertions`                | 1          | 1     |
| `anti-slop/max-ternary-depth`                         | 1          | 0     |
| `anti-slop/require-safety-comment-for-type-assertion` | 0          | 5     |

`anti-slop/no-comments` and `automation/no-comments` are intentionally off. The React, XState, Tailwind, and
API-layer `automation` rules do not apply to Fold.
