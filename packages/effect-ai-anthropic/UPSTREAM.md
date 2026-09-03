# Upstream provenance

This directory is a vendored source snapshot of the published Effect Anthropic provider. It does not contain upstream
`dist/` output.

| Field            | Value                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Upstream package | `@effect/ai-anthropic@4.0.0-rc.112`                                                               |
| Source artifact  | `https://registry.npmjs.org/@effect/ai-anthropic/-/ai-anthropic-4.0.0-rc.112.tgz`                 |
| npm integrity    | `sha512-2GQKD3IzfCJuS3DgeuBwUjEYk5iyOqgK5etQkYZ3Ho8IuL8BtGR9d8G5AIiRV0xkNy5DD4vGnDGSHxKWsW2TRg==` |
| Tarball SHA-256  | `4a1bc081405cd7b11e7b4a2f4d1f5eb113b72270ed58043fbd7d104b29e473fc`                                |
| Imported at      | `2026-09-03`                                                                                      |
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
