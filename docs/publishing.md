# Publishing

Releases are driven by pushed `v*` tags. `v1.2.3` publishes with the npm `latest` dist-tag. A prerelease uses its first prerelease identifier, so `v1.2.3-rc.2` publishes with `rc`.

## Effect AI provider fork versions

The three vendored provider packages are regular Fold libraries. Every Fold release publishes the matching version of:

- `@humanlayer/effect-ai-openai`
- `@humanlayer/effect-ai-anthropic`
- `@humanlayer/effect-ai-openai-compat`

For example, a Fold `v1.2.3` release publishes all three providers at `1.2.3`. This release version is independent
from the upstream Effect provider version. Each package's `UPSTREAM.md` records the exact upstream package artifact,
immutable checksum, import date, and HumanLayer delta used by that Fold release.

## One-time npm setup

Trusted publishing cannot create a package. A package's first version must be published manually by an npm owner.

### Initial release of the complete package family

For an initial Fold release, run the full build and staging process locally:

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

Authenticate and publish. The script publishes libraries (ending with `@humanlayer/fold-cli`), native packages, and
finally `@humanlayer/fold`. It is safe to rerun after a partial publish because existing package versions are skipped.

```bash
npm login
bun run release:publish --version 0.1.0 --tag latest
```

npm may briefly return `404` for a newly created package even though retrying the publish returns `403` because the
version already exists. During that registry propagation window, explicitly skip a version you have verified was
published:

```bash
bun run release:publish --version 0.1.0 --tag latest --skip @humanlayer/effect-branded-id
```

Repeat `--skip PACKAGE_NAME` for multiple verified packages if necessary. Do not skip a package based only on a failed
publish; confirm it appears in the npm organization's package access list first.

### Adding the Effect AI provider packages

The provider packages are being added to an existing release family. Do **not** use the complete-family publishing
command above: first create only the three new npm packages. npm cannot configure trusted publishing for a package
that does not yet exist. Use a unique bootstrap prerelease that will never be referenced by a Fold dependency, then
publish only the three staged provider directories from an npm-owner's machine:

```bash
export VERSION=0.1.0-provider-bootstrap.0 # choose an unused prerelease version

bun run build:packages --version "$VERSION"
bun run build:binaries --version "$VERSION"
bun run release:prepare --version "$VERSION"
bun run release:validate --version "$VERSION"

npm login
for package in effect-ai-openai effect-ai-anthropic effect-ai-openai-compat; do
  (cd ".release/packages/$package" && npm pack --dry-run && npm publish --access public --tag bootstrap)
done
```

For a package's first publish, npm also creates a `latest` tag even when `--tag bootstrap` is supplied. npm rejects
removing that tag while it is the package's only published version. Leave it in place: the next normal Fold release
will move `latest` to the corresponding stable provider version.

Check each result with `npm view @humanlayer/PACKAGE_NAME@"$VERSION" version`. The next normal Fold release publishes
the corresponding provider package at its Fold release version through trusted publishing.

### Trusted publishing

Trusted publishing is configured per existing npm package. Upgrade to npm 11.15 or later, ensure that 2FA is enabled
on the npm account, then add GitHub Actions as the trusted publisher. The first command requires interactive 2FA; npm
offers a five-minute grace period to approve the remaining commands without another challenge.

```bash
npm install --global npm@^11.15.0

for package in effect-ai-openai effect-ai-anthropic effect-ai-openai-compat; do
  npm trust github "@humanlayer/$package" \
    --repository humanlayer/fold \
    --file release.yml \
    --allow-publish \
    --yes
  sleep 2
done

for package in effect-ai-openai effect-ai-anthropic effect-ai-openai-compat; do
  npm trust list "@humanlayer/$package"
done
```

Leave the GitHub environment unspecified: the current release job does not declare one. npm requires this configuration
independently for each package. The trusted publisher must be added to all eleven library packages (including
`@humanlayer/fold-cli`), all twelve `@humanlayer/fold-*` native packages, and `@humanlayer/fold` (24 packages total).
Do not specify a GitHub environment unless the release workflow is updated to use the same protected environment.

After trusted publishing is configured, a partial release can be resumed from GitHub Actions. Run the `Release`
workflow manually with the same version and npm tag, and provide already-published packages as a comma-separated
`skip` value. Manual recovery runs publish packages but does not create a GitHub Release; the normal tag-triggered run
creates it after publication completes.

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
