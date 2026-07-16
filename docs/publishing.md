# Publishing

Releases are driven by pushed `v*` tags. `v1.2.3` publishes with the npm `latest` dist-tag. A prerelease uses its first prerelease identifier, so `v1.2.3-rc.2` publishes with `rc`.

## One-time npm setup

Trusted publishing cannot create a package. The first version of every package must be published manually by an npm owner:

1. Run the full build and staging process locally:

    ```bash
    bun install --frozen-lockfile
    bun run typecheck
    bun run test
    bun run build:packages --version 0.1.0
    bun run build:binaries --version 0.1.0
    bun run release:prepare --version 0.1.0
    bun run release:validate --version 0.1.0
    bun run release:publish --version 0.1.0 --tag latest --dry-run
    ```

2. Authenticate and publish. The script publishes libraries (ending with `@humanlayer/fold-cli`), native packages, and finally `@humanlayer/fold`. It is safe to rerun after a partial publish because existing package versions are skipped.

    ```bash
    npm login
    bun run release:publish --version 0.1.0 --tag latest
    ```

3. On npmjs.com, configure a GitHub Actions trusted publisher for every package. Use repository `humanlayer/fold` and workflow filename `release.yml`.

The trusted publisher must be added to all eight library packages (including `@humanlayer/fold-cli`), all twelve `@humanlayer/fold-*` native packages, and `@humanlayer/fold` (21 packages total). Do not specify a GitHub environment because the release job does not use one.

## Install choices

`@humanlayer/fold` is the canonical standalone Bun-compiled native distribution. Run it with `npx @humanlayer/fold`, or install it globally and use `foldcode`. Bare `foldcode`, `foldcode --resume ...`, and the explicit `foldcode tui` alias open the full-screen TUI. Use `foldcode --prompt "..."` for a noninteractive one-shot run.

`@humanlayer/fold-cli` is the optional Node.js JavaScript distribution. Its prompt, auth, config, sessions, and bin commands work under Node. Because Node cannot run OpenTUI, bare execution and `foldcode tui` fail immediately with guidance to use `--prompt` or install `@humanlayer/fold`; they never attempt to start the native TUI.

Human one-shot stdout contains only the final assistant response between stable markers. Logs, tool details, usage, and session metadata go to stderr. Extract the response (including multiline output) with:

```bash
foldcode --prompt "describe the change" 2>foldcode.log | awk '/^--- FOLDCODE ASSISTANT RESPONSE BEGIN ---$/{capture=1;next}/^--- FOLDCODE ASSISTANT RESPONSE END ---$/{capture=0;exit}capture'
```

For robust machine parsing, use `--output json` or `--output json-verbose` instead.

The native package intentionally maps its commands to `bin/foldcode.exe` on every platform. This is the universal launcher replaced by `postinstall.mjs`: keeping one target lets npm generate stable command shims before the platform-specific optional dependency is selected, and the `.exe` suffix makes that same target directly executable on Windows.

Do not add an npm token to GitHub. `.github/workflows/release.yml` uses npm trusted publishing through GitHub OIDC (`id-token: write`) with Node 24 and the latest npm.

## Validation and release

Run the `Validate Publish` workflow to cross-compile, stage, validate, and execute `npm publish --dry-run` without publishing. For later releases, push a tag such as `v0.1.1` or `v0.2.0-rc.1`. The release workflow validates the repository, publishes packages sequentially, and creates the GitHub Release only after all npm publishes succeed.
