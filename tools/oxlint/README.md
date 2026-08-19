# Vendored OXLint rules

This directory contains the selected rules that Fold owns and maintains:

- `anti-slop` rules are adapted from <https://github.com/dmmulroy/anti-slop>.
- `automation` rules are adapted from <https://github.com/typeonce-dev/ai-automation/tree/main/rules/oxlint>.

Only rules enabled in `.oxlintrc.jsonc` are vendored. Keep `@oxlint/plugins` aligned with the repository's
`oxlint` version when upgrading either package.
