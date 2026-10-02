# Type-aware and file rules

**Agent action: copy the engine or selected rules, then adapt discovery and
configuration.**

The three `src/rules` checks use the TypeScript Compiler API. The
`src/workspace-rules` area demonstrates a file-policy check for SVG markup.
`src/registry.ts` joins both kinds and `src/engine.ts` discovers projects,
normalizes relative diagnostics, sorts output, and removes duplicates.

`src/cli.ts` has honest command behavior: errors return `1`, configuration or
usage failures return `2`, and `fix` returns `2` without changing files because
the included rules are diagnostic-only.

Start from
[`examples/configuration/typed-lint/config.ts`](../../examples/configuration/typed-lint/config.ts).
Replace project globs, exclusions, severities, and file paths with the target
codebase’s ownership model. Invoke the scanner directly from its validation
boundary so every run observes current files.

Unit tests cover rule behavior and configuration. `test/integration` covers
recursive discovery, sorting, deduplication, configuration failures, exit
statuses, and command execution.
