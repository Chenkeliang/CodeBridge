# Web Slash Commands and Reasoning State Repair

- Date: 2026-08-14
- Status: Approved design
- Scope: CodeBridge Web command discovery and live timeline presentation

## 1. Objective

Restore two existing Web behaviors without changing message submission, queue,
Run cancellation, Provider resume, or channel command semantics:

1. Typing `/` in the Web Composer opens the selected Agent's native command and
   Skill suggestions for the active Workspace.
2. Reasoning and work blocks animate only while their owning Run is the
   authoritative active Run for the Session.

## 2. Non-goals

- No changes to Feishu or Telegram slash commands.
- No hard-coded Web command catalog.
- No Session schema or SQLite migration.
- No repair mutation over historical timeline rows.
- No changes to Composer Markdown, attachments, Send, Stop, or queue behavior.
- No work on the ignored second screenshot issue.

## 3. Root causes

### 3.1 Web slash commands

The rich Composer still detects trailing `/` tokens and the picker still
supports filtering, keyboard navigation, and insertion. The picker remains
closed because the Session Runtime read routes register
`GET /v1/sessions/:session_id/commands` before the existing Agent-aware route.
The first route returns only `session_commands` projections. Imported or newly
selected Provider Sessions can have no command projection even though Runner
can discover their native commands.

The later Agent-aware route already:

- asks Runner for commands using the Session's `agentId` and `cwd`;
- merges the latest Session-advertised `available_commands_update`;
- de-duplicates commands by name;
- returns projected commands when native discovery fails.

### 3.2 Reasoning spinner

Timeline rendering treats `block.status === "running"` as sufficient evidence
that a block is live. Historical migration can contain terminal Runs whose
projected blocks remain marked `running`, so hydrated reasoning blocks spin and
open indefinitely even when `runtime.active_run` is null.

The Session Runtime snapshot is the authority for whether a Run is currently
active. Historical block status alone is not an activity signal.

## 4. Design

### 4.1 Single Web command route

`GET /v1/sessions/:session_id/commands` has one owner: the Agent-aware route in
`session-api.ts`.

The duplicate command handler is removed from the Session Runtime read-route
registration. Other Runtime read routes remain unchanged.

The retained handler:

1. resolves the Session and its effective Workspace;
2. requests native commands from Runner for the selected Agent and Workspace;
3. merges the latest Session-advertised command update;
4. de-duplicates by command name, with Session-advertised metadata taking
   precedence;
5. returns a successful command list and includes a discovery error when Runner
   fails.

The Web Composer continues to open only for a trailing `/` token outside source
blocks. Selecting a suggestion inserts it into the draft and never executes it
until the user sends the message.

### 4.2 Authoritative live timeline state

`Workbench` passes `snapshot.runtime.active_run?.run_id ?? null` into
`SessionTimeline`.

`SessionTimeline` treats a block as live only when:

```text
block.run_id === activeRunId
```

That condition gates all transient presentation:

- reasoning/work/tool Spinner;
- automatic `<details>` expansion;
- Assistant streaming caret;
- live Assistant reveal eligibility.

The stored block status still controls terminal labels and content. A stale
historical `running` value cannot create live motion when its Run is not the
active Run. No database row is changed.

## 5. Error handling

- Missing Session continues to return `404`.
- Runner command discovery failure does not discard Session-advertised
  commands.
- The response preserves the Runner error so the caller can surface the
  unavailable discovery state rather than fabricating commands.
- An empty legitimate command list keeps the picker closed.
- A missing active Run always disables live timeline motion, including during
  hydration and Session switching.

## 6. Tests

### Bridge

- Native Runner commands appear for a Session with no command projection.
- Native and Session-advertised commands merge and de-duplicate correctly.
- Runner failure retains projected commands and exposes the error.
- Runtime Snapshot, Queue, Timeline, and Events GET behavior remains unchanged.

### Web

- Typing `/` with returned commands opens the command picker.
- Filtering and selecting a command still update only the active slash token.
- A stale `running` thought block does not spin or auto-open without a matching
  active Run.
- A thought block belonging to the active Run spins and opens.
- Assistant caret and reveal motion are limited to the active Run.
- Session switching and hydrated history do not replay live motion.

## 7. Acceptance criteria

1. Web `/` suggestions come from the current Agent and Workspace.
2. Feishu and Telegram slash behavior is unchanged.
3. Completed reasoning never spins solely because historical block status is
   stale.
4. Active reasoning retains its current Spinner and expanded presentation.
5. The repair requires no data migration and performs no historical writes.
