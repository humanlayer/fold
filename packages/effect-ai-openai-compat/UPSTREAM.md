# Upstream provenance

This directory is a vendored source snapshot of the published Effect OpenAI-compatible provider. It does not contain
upstream `dist/` output.

| Field            | Value                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Upstream package | `@effect/ai-openai-compat@4.0.0`                                                                  |
| Source artifact  | `https://registry.npmjs.org/@effect/ai-openai-compat/-/ai-openai-compat-4.0.0.tgz`                |
| npm integrity    | `sha512-zoFwI5M7pUEj4UMHMbPsQGaVRxirIAIqzfVZAtpjJPXWwd/acwxN4kI1nS9gfn/lCHvFIc9xPEMstforcODesw==` |
| Tarball SHA-256  | `d515c57d9bbbf328825d29db6df2a44e2fede63b1ac516577d0879dbe63570a3`                                |
| Imported at      | `2026-10-03`                                                                                      |
| Imported inputs  | `src/**`, `README.md`, and `LICENSE`                                                              |
| License          | MIT; copied to [`LICENSE`](./LICENSE)                                                             |

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
