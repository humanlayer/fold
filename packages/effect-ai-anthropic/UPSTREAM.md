# Upstream provenance

This directory is a vendored source snapshot of the published Effect Anthropic provider. It does not contain upstream
`dist/` output.

| Field            | Value                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Upstream package | `@effect/ai-anthropic@4.0.0`                                                                      |
| Source artifact  | `https://registry.npmjs.org/@effect/ai-anthropic/-/ai-anthropic-4.0.0.tgz`                        |
| npm integrity    | `sha512-/xZYmvRE9yDLKiz1pOIx0CVaB+o0zdJd6sTG9KQbFSkM+Ule0U/6yeN+Q6KD9I7Z73t3WxhK9Xmg1eqU6+IVmQ==` |
| Tarball SHA-256  | `68969de51307457a74aea94273f05f7eab7b570f940ade95bf57b8847fe8e355`                                |
| Imported at      | `2026-10-03`                                                                                      |
| Imported inputs  | `src/**`, `README.md`, and `LICENSE`                                                              |
| License          | MIT; copied to [`LICENSE`](./LICENSE)                                                             |

## HumanLayer delta

- `src/AnthropicLanguageModel.ts` preserves string tool results, converts ordered `Prompt` text/image parts into
  Anthropic `tool_result` content, and continues to JSON-stringify unknown result objects.
- Provider service/config keys use the `@humanlayer/effect-ai-anthropic` namespace so upstream and forked layers
  cannot satisfy one another accidentally in the same Effect context.
- `test/HumanlayerFork.test.ts` covers the changed behavior through the public HumanLayer provider package.

## Refresh rule

Refresh from a released npm package or an explicit immutable upstream commit that has been verified against the
supported `effect` peer runtime. Update this table and review the full source diff; do not sync from a moving branch
reference or hand-edit generated `src/Generated.ts`.
