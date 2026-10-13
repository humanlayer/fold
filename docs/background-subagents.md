# Background subagents

Fold can run a subagent in the background: the tool call that launches it returns at once, the
launching agent keeps working (or ends its turn), and fold tells the launcher when the subagent
finishes. The design follows Claude Code's background agents, and the data maps one to one onto a
host's task table (HumanLayer's `session_background_tasks`).

## Launching

The `subagent` tool takes `run_in_background: true` together with any of its selectors:

| Call                                                       | Effect                                           |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `{ agent, prompt, description?, run_in_background: true }` | dispatch a fresh subagent as a background task   |
| `{ fork: true, prompt, run_in_background: true }`          | fork the caller's context into a background task |
| `{ agent_id, prompt, run_in_background: true }`            | resume an earlier subagent as a background task  |

The call returns a receipt such as:

```text
Background agent started. agent_id: agent_ab12cd34
It is working in the background. You will be notified with a <task-notification> message when it
finishes, so do not poll for it. ...
```

The task id is the subagent's agent id. Without `run_in_background` the subagent runs in the
foreground exactly as before: the call blocks and returns the subagent's result.

## What the launcher sees when it finishes

When a background run ends, fold writes a user message for the launcher:

```xml
<task-notification>
<task-id>agent_ab12cd34</task-id>
<status>completed</status>
<summary>Background agent "find the config loader" completed</summary>
<result>
...the subagent's final message...
</result>
<usage>turns: 3, tool uses: 7</usage>
<note>The agent keeps its context. Send it a message with agent_id agent_ab12cd34 to continue it.</note>
</task-notification>
```

`status` is `completed`, `failed` (with an `<error>`), or `stopped`. The message carries
`origin: { _tag: 'task-notification', taskIds }`, so UIs can render it as a system row; the model sees
the text like any user message.

Delivery:

1. If the launcher is a subagent that is still running, the notification is queued as a follow-up for
   it and drains when its run would otherwise complete.
2. Otherwise the notification goes to the root agent:
    - root running: a follow-up of the current run (drained at its natural completion);
    - root idle: a **wake** - a new root run whose input is the notification. Wakes go through the same
      gate and running-agent claim as `send`, so they never overlap a user turn or a model switch.
3. Coalescing: everything queued when a wake takes the gate goes into that one wake, and adjacent queued
   notifications drain as a single user message. Two agents finishing together produce one turn.
4. If a run ends before consuming its follow-up (it was stopped or interrupted), the notification goes
   back to the queue and is delivered again.

## Controls

### Model tools

`agentControlTools()` returns three tools to install next to a `subagentTool` value (the fold-agent
coding and RLM modes do this):

| Tool           | Parameters              | Behavior                                                                                                                                                      |
| -------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_agents`  | none                    | running and finished tasks with status, description, turns, tool uses, last tool, and the start of the result or error                                        |
| `stop_agent`   | `{ agent_id }`          | interrupts a running task; it ends `stopped`. No notification follows: the caller already knows                                                               |
| `send_message` | `{ agent_id, message }` | running agent: steered (read after its current step). Finished or stopped agent: resumed in the background with its full context; it notifies again when done |

### Session API

```ts
type FoldSession = {
	// ...existing members
	readonly backgroundTasks: Effect<ReadonlyArray<BackgroundTask>>
	readonly backgroundTaskChanges: Stream<ReadonlyArray<BackgroundTask>>
	readonly stopTask: (taskId: AgentId | string) => Effect<boolean, SubagentNotFoundError>
	readonly awaitBackgroundIdle: Effect<void>
}
```

- `stopTask(id)` accepts a full id or a unique short reference. It interrupts the run, records it
  `stopped`, and notifies the launcher like any completion. It resolves `false` when the task is not
  running.
- `awaitBackgroundIdle` resolves when no task is running, no wake is scheduled or running, and no
  notification is waiting for delivery. Headless hosts await it after `send`.
- `interrupt()` with no target interrupts the foreground only: the root's run and any running agent that
  is not a background task or beneath one. Background tasks keep running and still wake the root when
  they finish. `interrupt({ agentId })` on a background task stops that task.
- `stop()` stops running background tasks (recorded `stopped`) and requests the usual graceful stop for
  the foreground. Their notifications do not wake the root; they are steered into the root's next run,
  before its first model call.
- Closing the session scope interrupts every background run; each one is recorded `stopped` before the
  session's services are released.
- Opening an existing log rebuilds the task list from its rows. A run that has `task_started` but no
  `task_finished` (the process died) is recorded `stopped`, and its notification waits for the root's
  next run.

The `send(text, { agentId })` and `steer(text, { agentId })` targets also work on background tasks.

`BackgroundTask`:

| Field                                | Meaning                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `taskId`                             | the background agent's id                                                                              |
| `toolCallId`                         | the tool call that launched the latest run (a `subagent` or `send_message` call)                       |
| `parentAgentId`                      | the launcher; it is notified                                                                           |
| `taskType`                           | `'subagent'`                                                                                           |
| `agentType`                          | registry type name; null for forks                                                                     |
| `description`, `prompt`              | the label and the message the latest run started with                                                  |
| `status`                             | `running`, `completed`, `failed`, or `stopped`                                                         |
| `isBackgrounded`                     | always true today (foreground runs are not recorded as tasks)                                          |
| `startedAt`, `endedAt`, `notifiedAt` | epoch millis for the latest run                                                                        |
| `usage`                              | `{ turns, toolUses, totalTokens }` for the latest run (`totalTokens`: context size at the latest turn) |
| `lastToolName`, `progressSummary`    | live activity while running                                                                            |
| `summary`, `error`                   | the latest run's final text or error                                                                   |
| `runCount`                           | 1, plus one per resume                                                                                 |

## Events

Durable log rows (additive to the v1 log format; older logs decode unchanged):

- `task_started` on the task agent's envelope: `taskType`, `agentType`, `description`, `prompt`,
  `isBackgrounded`, `runCount`. Written after the agent's `agent_started` (or resume) rows and before its
  first message.
- `task_finished`: `status`, `summary`, `error`, `usage`, `durationMs`, `lastToolName`. Written by an
  uninterruptible finalizer, so every run that started gets one.
- `user-message.origin` (optional): `{ _tag: 'task-notification', taskIds }` on runtime-written
  notification messages.

Ephemeral delta on `session.events()`: `{ type: 'task-progress', taskId, turns, toolUses, totalTokens,
lastToolName, progressSummary }`, published after each of the task agent's turns.

## CLI and TUI

- `foldcode --prompt` waits after its own turn until background agents and their notification turns are
  done, then exits with the root's latest outcome. `--background-timeout <seconds>` caps the wait
  (default 600); agents still running then are stopped. Ctrl+C while waiting stops them.
- The line renderer prints `[background] agent_x started: ...` and
  `[background] agent_x completed (3 turns, 7 tool uses)` lines, and a wake as
  `[notification] background agent agent_x finished`.
- In the TUI, the SUBAGENTS rail marks background agents with `BG`, the rail header and the activity
  label count them (`1 RUN · 1 BG`), `x` stops the selected running background agent, and a wake shows
  as an `AGENTS` row with each agent's summary instead of a `USER` row.

## Limits

- Only subagents run in the background; there are no background shells or monitors.
- A foreground subagent cannot be moved to the background mid-run (no Ctrl+B equivalent).
- There is no concurrency cap on background tasks.
- Notifications are in memory until delivered. A process that dies with an undelivered notification
  loses it; the durable `task_finished` row remains.
