# alchemy-cloudflare

A minimal fold chat host on Cloudflare, deployed with [Alchemy v2](https://alchemy.run/cloudflare/). Inference runs on OpenAI (`gpt-5.6-terra`, medium reasoning) through fold's `openaiModel`. Each fold session is one Durable Object, named by its `SessionId`.

- `src/ChatSession.ts` — the Durable Object. It opens the fold log in its SQLite on activation; the first message starts the session, later activations resume it.
- `src/DurableObjectEventLog.ts` — the service that opens fold's `EventLogService` over the object's SQLite.
- `src/Keepalive.ts` — a 30s alarm heartbeat that keeps the object alive while a turn runs.
- `src/ChatSessions.ts` — the service the routes require; its `layer` reaches each session's Durable Object.
- `src/Api.ts` — the `HttpRouter` routes, encoding responses with fold's log schemas.
- `src/Worker.ts` — serves the routes, with `ChatSessions` as RPC to the Durable Objects.
- `alchemy.run.ts` — the stack.

## Run

```sh
echo 'OPENAI_API_KEY=sk-...' > .env   # read at deploy time, stored on the Worker as a secret
bun alchemy profile edit --add Cloudflare
bun run dev                       # local workerd
bun run deploy                    # prints the Worker url
```

```sh
ID=sess_...   # any new SessionId; the first message starts that session
curl -X POST "$URL/sessions/$ID/messages" -d '{"text":"hi"}'                              # the agent-finished entry
curl -X POST "$URL/sessions/$ID/messages" -d '{"text":"stop","whenRunning":"interrupt"}'  # queue (default) | steer | interrupt
curl "$URL/sessions/$ID"                                                                  # all log entries
```

`bun run test` checks the routes against an in-memory `ChatSessions` built on fold's in-memory log.

## Limits

- A turn cut off by a crash or deploy continues when the object next wakes, through a synthetic "continue" user message (at most 3 per cut-off turn). A subagent cut off with it is left for the root model to resume by id.

- Replies arrive whole. `FoldSession.events` can stream deltas once a route forwards them.
