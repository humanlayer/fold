# fold

An Effect-native, provider-agnostic, isomorphic agent loop with an optional opinionated CLI and TUI, inspired by
pi's small and practical design.

Fold's core is not tied to coding, a terminal, or a specific model provider. It gives you an API for composing models,
tools, prompts, hooks, subagents, compaction, and durable sessions. The optional agent package adds opinions for
working on codebases, while the CLI and TUI provide ready-to-use interfaces. Everything is built with Effect: typed
errors, scoped resources, layers, streams, concurrency, and configuration.

<!-- Replace this comment with: ![fold TUI](docs/fold-tui.png) -->

## Highlights

- **CLI + TUI** — work interactively, resume durable sessions, inspect changes, switch models, and manage providers.
- **Headless by design** — run `foldcode --prompt "fix the tests"` with human or JSONL output.
- **Bring your model** — connect Anthropic and OpenAI-compatible APIs with custom base URLs and model IDs.
- **Use your subscriptions** — authenticate with Codex, OpenCode, or xAI/Grok through browser or device OAuth flows.
- **Isomorphic core** — run the provider-neutral loop inside or outside a terminal and bring your own models, tools,
  hooks, prompts, storage, and agent definitions.
- **Optional coding agent** — add batteries-included coding tools, durable sessions, model roles, compaction, and
  sensible repository defaults when that is what you need.
- **Pi-shaped** — a focused model + prompt + tools design, without a large framework hidden behind the agent.
- **Subagents** — define and run specialist agents, including recursive and RLM-like orchestration patterns.

## Try It

Fold is currently run from source and requires [Bun](https://bun.sh/).

```bash
bun install
bun run packages/fold-cli/src/cli.ts config init

# Full-screen TUI
bun run packages/fold-cli/src/cli.ts tui

# One-shot / CI
bun run packages/fold-cli/src/cli.ts --prompt "fix the failing tests" --output json
```

Authenticate subscription-backed providers from the CLI or provider page in the TUI:

```bash
bun run packages/fold-cli/src/cli.ts auth codex login
bun run packages/fold-cli/src/cli.ts auth opencode login
bun run packages/fold-cli/src/cli.ts auth xai login
```

API-key providers support `anthropic` and `openai-compat` protocols, including custom base URLs. Credentials,
configuration, and session state live under `~/.fold` by default.

## Development

```bash
bun run test
bun run typecheck
bun run lint
bun run format:check
```

## Architecture

- `packages/fold-core` — an isomorphic, provider-agnostic API for defining and running agent loops.
- `packages/fold-agent` — the opinionated coding agent: tools, modes, configuration, model roles, and session storage.
- `packages/fold-cli` — the headless CLI, interactive CLI, and full-screen OpenTUI application.

Build any kind of agent directly on the core API, import the agent package for an opinionated coding setup, or use
the CLI and TUI as a ready-made application.

## License

[MIT](LICENSE)
