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
- `effect-branded-id`: Effect schemas and generators for type-safe, prefixed CUID2 identifiers

## Isomorphic agents with `fold-core`

Define an agent with model and tool descriptors, then open a session. Custom event-log backends are supplied through normal Effect layer composition. Provider and tool-runtime wiring stays internal.

```ts
import { anthropicModel, defineAgent, Session } from '@humanlayer/fold-core'
import { Config, Effect } from 'effect'

export const ask = (prompt: string) =>
	Effect.gen(function* () {
		const apiKey = yield* Config.Redacted('ANTHROPIC_API_KEY')
		const agent = defineAgent({
			name: 'assistant',
			model: anthropicModel({ model: 'claude-sonnet-4-6', apiKey }),
			systemPrompt: 'Be concise and helpful.',
		})
		const session = yield* Session.open({ agent }) // in-memory by default
		return yield* session.send(prompt)
	}).pipe(Effect.scoped)
```

`defineTool` and model descriptors keep agent configuration portable. `Session.open` initializes an empty log or resumes the session recorded in an existing one. Without a supplied `EventLog`, each call creates a fresh, isolated in-memory log.

## Custom coding agents with `fold-agent`

Compose `fold-agent`'s platform tools and JSONL backend with the same `fold-core` API. `codingTools({ cwd })` installs the complete tool union; `fold-core` selects the advertised tools from the active model on every request: Claude gets `write`/`edit`, while GPT/Codex gets `apply_patch`. Switching models reselects the tools automatically.

```ts
import { codingTools, layerCodingToolServices, layerJsonl } from '@humanlayer/fold-agent'
import { anthropicModel, defineAgent, Session } from '@humanlayer/fold-core'
import { Config, Effect, Layer } from 'effect'

const hostServices = layerCodingToolServices({ outputDirectory: '.fold/tool-output' })
const eventLog = layerJsonl('.fold/review.jsonl').pipe(Layer.orDie)

const program = Effect.gen(function* () {
	const apiKey = yield* Config.Redacted('ANTHROPIC_API_KEY')
	const cwd = '.'
	const agent = defineAgent({
		name: 'reviewer',
		model: anthropicModel({ model: 'claude-sonnet-4-6', apiKey }),
		systemPrompt: 'Review the project. Make changes only when explicitly asked.',
		tools: codingTools({ cwd }),
		autoCompact: { enabled: true },
	})
	const session = yield* Session.open({ agent, cwd })
	return yield* session.send('Find the highest-risk code in this project.')
}).pipe(Effect.provide(eventLog.pipe(Layer.provideMerge(hostServices))), Effect.scoped)
```

The supplied backend represents one session, with at most one active handle. Reuse its service within
that session, not as an application-wide default for unrelated sessions. Layer memoization shares
instances by reference; Fold creates default memory logs and internal session graphs with fresh memo
maps, but deliberately adopts the exact host-supplied log. A fresh layer pointing at the same file is
still the same persistent log, not an isolated session.

Keep session construction **and use** within the owning scope. Long-lived hosts can build the backend
once into their session/object scope with `Layer.buildWithMemoMap` and provide the resulting context
for later calls. Storage acquisition errors are treated as defects using `Layer.orDie`.

Existing log identity is authoritative. A conflicting `sessionId`, a nonempty log without valid session
history, or multiple session starts fails rather than silently initializing a new session. `cwd` and
`meta` apply only to initialization; resumed model/prompt changes are recorded as configuration epochs.

### API migration

This is a breaking API change: replace `startSession` / `resumeSession` with `Session.open` and remove
`log` from the options. `FoldEventLog`, `memoryEventLog`, `eventLogSource`, and `jsonlEventLog` have been
removed. Supply `layerInMemoryEventLog`, `layerJsonl`, `layerJsonlWithIds`, or `layerJsonlNode` through the
Effect environment instead. `prepareSessionLog` now returns only the session id and path.
