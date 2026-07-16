# Fold

![Fold TUI themes](.github/assets/fold-themes.webp)

Fold is an Effect-native, provider-agnostic, isomorphic agent core with an optional opinionated coding agent, CLI, and TUI. It supports multiple model providers (including openai/anthropic-compatible and subscription-backed providers for Codex, Grok, and OpenCode Zen), subagents, and RLM-like orchestration patterns.

```sh
npm install -g @humanlayer/fold
foldcode                         # open the interactive TUI
foldcode --prompt "fix the tests" # noninteractive; framed assistant output goes to stdout; useful for CI
foldcode auth --help             # configure and manage authentication
```

`foldcode auth ...` handles provider authentication. The separately published `@humanlayer/fold-cli` package is an optional Node/headless CLI; it does not provide the TUI.

- `fold`: skeleton package for CLI distribution
- `fold-core`: the isomorphic core with log-based state, tool support, hook support, subagents and skill facades, event streaming, auto-compaction, session management
- `fold-agent`: opinionated agent with built-in profiles, filesystem tools (`read`, `write` + `edit` for claude models / `apply_patch` for codex ones, `bash`, `skill`, `agent`, `web_search` and `web_fetch`); sane hook configuration
- `fold-cli`: CLI & TUI package
- `fold-codex`: effect codex provider
- `fold-opencode`: effect opencode zen provider
- `fold-tui-theme`: theme tokens and example app
- `fold-xai`: effect XAI provider

## Isomorphic agents with `fold-core`

The ergonomic API is descriptor-based: define an agent, then run it against a session backend. No Effect `Layer`, `Toolkit`, or runtime wiring is exposed.

```ts
import { anthropicModel, defineAgent, startSession } from '@humanlayer/fold-core'
import { Config, Effect } from 'effect'

export const ask = (prompt: string) =>
	Effect.gen(function* () {
		const apiKey = yield* Config.redacted('ANTHROPIC_API_KEY')
		const agent = defineAgent({
			name: 'assistant',
			model: anthropicModel({ model: 'claude-sonnet-4-6', apiKey }),
			systemPrompt: 'Be concise and helpful.',
		})
		const session = yield* startSession({ agent }) // in-memory by default
		return yield* session.send(prompt)
	}).pipe(Effect.scoped)
```

`defineTool`, model descriptors, and event-log descriptors use the same data-first API, so hosts can supply browser, worker, or filesystem implementations without changing the agent definition.

## Custom coding agents with `fold-agent`

Compose `fold-agent`'s platform tools and JSONL backend with the same `fold-core` API. `codingTools({ cwd })` installs the complete tool union; `fold-core` selects the advertised tools from the active model on every request: Claude gets `write`/`edit`, while GPT/Codex gets `apply_patch`. Switching models reselects the tools automatically.

```ts
import { codingTools, jsonlEventLog } from '@humanlayer/fold-agent'
import { anthropicModel, defineAgent, startSession } from '@humanlayer/fold-core'
import { Config, Effect } from 'effect'

const program = Effect.gen(function* () {
	const apiKey = yield* Config.redacted('ANTHROPIC_API_KEY')
	const cwd = '.'
	const agent = defineAgent({
		name: 'reviewer',
		model: anthropicModel({ model: 'claude-sonnet-4-6', apiKey }),
		systemPrompt: 'Review the project. Make changes only when explicitly asked.',
		tools: codingTools({ cwd }),
		autoCompact: { enabled: true },
	})
	const session = yield* startSession({ agent, cwd, log: jsonlEventLog('.fold/review.jsonl') })
	return yield* session.send('Find the highest-risk code in this project.')
}).pipe(Effect.scoped)
```
