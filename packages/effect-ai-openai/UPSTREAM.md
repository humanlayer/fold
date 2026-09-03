# Upstream provenance

This directory is a vendored source snapshot of the published Effect OpenAI provider. It does not contain upstream
`dist/` output.

| Field            | Value                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Upstream package | `@effect/ai-openai@4.0.0-rc.112`                                                                  |
| Source artifact  | `https://registry.npmjs.org/@effect/ai-openai/-/ai-openai-4.0.0-rc.112.tgz`                       |
| npm integrity    | `sha512-j2X86xvgpAtNiusyESADHZn3PUzMVatE1zWXd0No2aybx/euKiVBVWZOtzq7ntJ5KvPHRBOFXTGPADdApQrwug==` |
| Tarball SHA-256  | `26902ae06ec9118172f8033e84d4bffa19c0a6d3be56a42bc1147a6a131e4e43`                                |
| Imported at      | `2026-09-03`                                                                                      |
| Imported inputs  | `src/**`, `README.md`, and `LICENSE`                                                              |
| License          | MIT; copied to [`LICENSE`](./LICENSE)                                                             |

## HumanLayer delta

- `src/OpenAiLanguageModel.ts` preserves string tool results, converts ordered `Prompt` text/image parts into
  Responses `function_call_output` content, and continues to JSON-stringify unknown result objects. Raw base64 image
  strings, byte arrays, file IDs, URLs, and data URLs are encoded as `input_image` values.
- `src/OpenAiSchema.ts` accepts provider stream-error events that omit `code`, `param`, or `sequence_number`, in both
  flat and nested error shapes.
- Provider service/config keys use the `@humanlayer/effect-ai-openai` namespace so upstream and forked layers cannot
  satisfy one another accidentally in the same Effect context.
- `test/HumanlayerFork.test.ts` covers the changed behavior through the public HumanLayer provider package.

## Refresh rule

Refresh from a released npm package or an explicit immutable upstream commit that has been verified against the
supported `effect` peer runtime. Update this table and review the full source diff; do not sync from a moving branch
reference or hand-edit generated `src/Generated.ts`.
