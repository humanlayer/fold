# Fold

Fold is an Effect-native, provider-agnostic, isomorphic agent core with an optional opinionated coding agent, CLI, and TUI. It supports multiple model providers (including subscription-backed providers), subagents, and RLM-like orchestration patterns.

```sh
npm install -g @humanlayer/fold
foldcode                         # open the interactive TUI
foldcode --prompt "fix the tests" # noninteractive/CI; framed assistant output goes to stdout
foldcode auth --help             # configure and manage authentication
```

`foldcode auth ...` handles provider authentication. The separately published `@humanlayer/fold-cli` package is an optional Node/headless CLI; it does not provide the TUI.
