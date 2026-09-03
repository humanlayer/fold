# Upstream provenance

This directory is a vendored source snapshot of the published Effect OpenAI-compatible provider. It does not contain
upstream `dist/` output.

| Field            | Value                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Upstream package | `@effect/ai-openai-compat@4.0.0-rc.112`                                                              |
| Source artifact  | `https://registry.npmjs.org/@effect/ai-openai-compat/-/ai-openai-compat-4.0.0-rc.112.tgz`            |
| npm integrity    | `sha512-bfNYHgfjhzKhD7E1j1g2wPqAIucH6xiFylpT7YGVjF8SuF4i7TY5iLzfHp9Hr1RvF8fwiSGHt9nvnzrixGOkG9YZw==` |
| Tarball SHA-256  | `add1fb7a94bfcb8cd1e16ce2f8ba40296bba7d6eab55b9b230af3e3e53d12489`                                   |
| Imported at      | `2026-09-03`                                                                                         |
| Imported inputs  | `src/**`, `README.md`, and `LICENSE`                                                                 |
| License          | MIT; copied to [`LICENSE`](./LICENSE)                                                                |

This initial import preserves upstream provider behavior. Its Effect service/config keys use the
`@humanlayer/effect-ai-openai-compat` namespace, so upstream and forked layers cannot satisfy one another accidentally
in the same Effect context. It is vendored with the OpenAI and Anthropic providers so Fold and Riptide use one
HumanLayer-owned provider family.

[`UPSTREAM.sha256`](./UPSTREAM.sha256) records the checksum of each unmodified imported provider source and metadata
file. Its regression test also verifies the deliberate HumanLayer service-key delta.

## Refresh rule

Refresh from a released npm package or an explicit immutable upstream commit that has been verified against the
supported `effect` peer runtime. Update this table and review the full source diff; do not sync from a moving branch
reference.
