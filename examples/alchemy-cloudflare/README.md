# alchemy-cloudflare

A minimal fold chat host on Cloudflare, deployed with [Alchemy v2](https://alchemy.run/cloudflare/). Inference runs on OpenAI (`gpt-5.6-terra`, medium reasoning) through fold's `openaiModel`. Each fold session is one Durable Object, named by its `SessionId`, with a workspace of cloned repos in a second one of the same name.

- `src/ChatSession.ts` — the Durable Object. It opens the fold log in its SQLite on activation; the first message clones its repos and starts the session, later activations resume it.
- `src/DurableObjectEventLog.ts` — the service that opens fold's `EventLogService` over the object's SQLite.
- `src/Keepalive.ts` — a 30s alarm heartbeat that keeps the object alive while a turn runs.
- `src/SessionExpiry.ts` — deletes an idle session and its workspace; see below.
- `src/ChatSessions.ts` — the service the routes require; its `layer` reaches each session's Durable Object.
- `src/Workspace.ts` — the service ChatSession clones repos and reaches files through; its `layer` reaches the session's Computer.
- `src/BashTool.ts` — the agent's `bash` tool, running commands in the workspace's shell.
- `src/WorkspaceFileSystem.ts` — Effect's `FileSystem` over the Computer's file methods, so fold-agent's file tools and skill loader run on the workspace unchanged.
- `src/computer/` — the Computer Worker: a plain Durable Object holding a [`@cloudflare/computer`](https://github.com/cloudflare/computer) workspace (a filesystem in its SQLite, with git and a shell) per session. The shell is just-bash in a Worker that a Worker Loader starts, reading and writing the same filesystem. A separate Worker, because `@cloudflare/computer` needs the plain `cloudflare:workers` class, and an Effect Worker's bundle keeps only its own exports.
- `src/Api.ts` — the `HttpRouter` routes, encoding responses with fold's log schemas.
- `src/Worker.ts` — serves the routes, with `ChatSessions` as RPC to the Durable Objects.
- `alchemy.run.ts` — the stack: the Computer Worker, then the chat Worker, which binds it by script name.

## Run

```sh
echo 'OPENAI_API_KEY=sk-...' > .env   # read at deploy time, stored on the Worker as a secret
bun alchemy profile edit --add Cloudflare
bun run dev                       # local workerd
bun run deploy                    # prints the Worker url
```

```sh
ID=sess_...   # any new SessionId; the first message clones its repos and starts that session
curl -X POST "$URL/sessions/$ID/messages" -d '{"text":"hi","repos":[{"url":"https://github.com/humanlayer/fold"}]}'  # the agent-finished entry
curl -X POST "$URL/sessions/$ID/messages" -d '{"text":"hi"}'                              # later messages' repos are ignored
curl -X POST "$URL/sessions/$ID/messages" -d '{"text":"stop","whenRunning":"interrupt"}'  # queue (default) | steer | interrupt
curl "$URL/sessions/$ID/log"                                                              # the fold event log
```

A session with no messages for 14 days (`IDLE_TIME` in `src/SessionExpiry.ts`) deletes its workspace and its log; its id then starts a new session. The workspace also has its own deadline a day later, so it gets deleted even if its session never does it.

`bun alchemy tail` streams both Workers' logs. Each clone logs `workspace.prepare`, each file call from the agent's tools logs `workspace.file` with its method, path and result, and each shell command logs `workspace.exec` with its exit code.

Each repo is `{ "url": "https://...", "name"?: string, "ref"?: string }`: it clones into `/workspace/<name>` (`name` defaults to the URL's last path segment) at `ref` (the default branch when absent), shallow. A repo that fails to clone makes the first message a 422 and starts nothing; the next message clones again from scratch. The log's `session_started` entry records each repo's commit.

The agent gets fold-agent's file tools on the workspace: `read`, plus `write` and `edit` for Claude models or `apply_patch` for GPT models (fold picks by model). Relative paths resolve against `/workspace`. It also gets `bash`, which runs in a lightweight shell: the common text commands (`ls`, `cat`, `grep`, `find`, `sed`, `awk`, `jq`, ...), pipes and redirects, and git. The shell and the file tools see the same files. Skills load from each repo's `.claude/skills` and `.agents/skills` when the session opens. The system prompt lists the repos.

`bun run test` checks the routes against an in-memory `ChatSessions` built on fold's in-memory log.

## Limits

- A turn cut off by a crash or deploy continues when the object next wakes, through a synthetic "continue" user message (at most 3 per cut-off turn). A subagent cut off with it is left for the root model to resume by id.

- The shell is not a full Linux machine: no package managers, no node or python, no compilers, and no network. It can't install, build, or run tests.

- The file tools read and write the workspace, not the repos' remotes: changes stay in the session's workspace. `read` can't process images in a Worker (its image library needs Node), so an image comes back as a short note, not the picture.

- The Computer Worker's script name is fixed (`src/computer/Contract.ts`), so an account holds one deploy of this stack.

- Clones go over HTTPS, public repos only. They run in the Durable Object through `isomorphic-git`, which fetches every file at the tip, so large repos clone slowly.

- Replies arrive whole. `FoldSession.events` can stream deltas once a route forwards them.
