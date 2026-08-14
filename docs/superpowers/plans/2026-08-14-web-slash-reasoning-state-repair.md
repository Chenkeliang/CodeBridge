# Web Slash Commands and Reasoning State Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore dynamic Agent-native `/` suggestions in the Web Composer and stop stale historical reasoning blocks from presenting as live.

**Architecture:** Keep one Agent-aware Bridge command endpoint that merges Runner-native and Session-advertised commands. Pass the Session Runtime's authoritative active Run ID into the Web timeline and gate every transient animation by the owning Turn's Run ID.

**Tech Stack:** TypeScript, Hono, React 19, Vitest, SQLite-backed Session Runtime, pnpm

---

## File map

- Modify `apps/bridge/src/session-runtime-api.ts`
  - Stop registering the duplicate projection-only `/commands` GET route.
- Modify `apps/bridge/src/session-api.test.ts`
  - Prove the remaining route merges native and Session-advertised commands and degrades explicitly.
- Modify `apps/web/src/components/session-timeline.tsx`
  - Gate Spinner, automatic expansion, reveal motion, and streaming caret by the active Run.
- Modify `apps/web/src/components/session-timeline.test.tsx`
  - Cover stale terminal blocks and matching active blocks.
- Modify `apps/web/src/components/workbench.tsx`
  - Pass the authoritative active Run ID from the Session snapshot.

No schema, migration, channel router, Composer codec, or submission file changes.

### Task 1: Restore Agent-native Web slash commands

**Files:**
- Modify: `apps/bridge/src/session-api.test.ts:1464-1510`
- Modify: `apps/bridge/src/session-runtime-api.ts:308-316`

- [ ] **Step 1: Change the command merge test to require native and Session-advertised commands**

Replace the empty assertion in `merges native and session-advertised Agent commands` with:

```ts
expect(response.status).toBe(200);
expect(await response.json()).toEqual({
  commands: [
    { name: "skill:review", description: "Review" },
    { name: "compact", description: "Compact context" },
  ],
});
```

- [ ] **Step 2: Change the Runner-failure test to require projected fallback and an explicit error**

Create a task record and append an advertised command before requesting the endpoint:

```ts
const message = await app.request(`/v1/sessions/${session.id}/messages`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ message: "hello" }),
});
const taskId = (
  await message.json() as { task_record_id: string }
).task_record_id;
workItems.appendEvent({
  workItemId: taskId,
  type: "AGENT_EVENT",
  actor: "adapter",
  payload: {
    event: {
      type: "available_commands_update",
      availableCommands: [{
        name: "compact",
        description: "Compact context",
      }],
    },
  },
});
```

Replace the final assertion with:

```ts
expect(await response.json()).toEqual({
  commands: [{ name: "compact", description: "Compact context" }],
  error: "Runner command endpoint unavailable",
});
```

- [ ] **Step 3: Run the two tests and verify they fail against the projection-only route**

Run:

```bash
pnpm exec vitest run apps/bridge/src/session-api.test.ts \
  -t "merges native and session-advertised Agent commands|keeps the command menu available"
```

Expected: both tests fail because the earlier Runtime route returns only the local `session_commands` projection.

- [ ] **Step 4: Remove the duplicate Runtime command GET route**

Delete this block from `registerSessionRuntimeReadRoutes` in
`apps/bridge/src/session-runtime-api.ts`:

```ts
app.get("/v1/sessions/:session_id/commands", (c) => {
  if (!options.catalog.getSession(c.req.param("session_id"))) {
    return c.json({ error: "session_not_found" }, 404);
  }
  return c.json({
    commands: options.workItems.listSessionCommands(
      c.req.param("session_id"),
    ),
  });
});
```

Do not change Snapshot, Timeline, Queue, Events, or mutation routes. The
Agent-aware handler already registered later in `session-api.ts` becomes the
single owner of this path.

- [ ] **Step 5: Run the focused Bridge tests**

Run:

```bash
pnpm exec vitest run apps/bridge/src/session-api.test.ts \
  -t "keeps GET|merges native and session-advertised Agent commands|keeps the command menu available"
```

Expected: all selected tests pass. The GET read-only matrix must continue to
prove that `/commands` performs no CodeBridge database write.

- [ ] **Step 6: Commit the command repair**

```bash
git add apps/bridge/src/session-runtime-api.ts apps/bridge/src/session-api.test.ts
git commit \
  -m "fix(bridge): restore native web slash commands" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Gate live timeline motion by the active Run

**Files:**
- Modify: `apps/web/src/components/session-timeline.test.tsx`
- Modify: `apps/web/src/components/session-timeline.tsx`
- Modify: `apps/web/src/components/workbench.tsx:763-772`

- [ ] **Step 1: Add the active Run property to timeline test defaults**

Update `timelineProps` in
`apps/web/src/components/session-timeline.test.tsx`:

```ts
const timelineProps = {
  activeRunId: null as string | null,
  hasEarlier: false,
  loadingBlockId: null,
  loadingEarlier: false,
  onLoadEarlier: vi.fn(),
  onLoadSegments: vi.fn(),
};
```

Add `activeRunId={null}` to the first direct `SessionTimeline` render that does
not spread `timelineProps`.

- [ ] **Step 2: Add a regression test for a stale terminal reasoning block**

Add:

```tsx
it("does not animate a stale running thought without an active Run", () => {
  const stale = timelineTurn(
    "thought",
    [segment("stale-thought", "已经完成", false)],
  );
  stale[0]!.status = "succeeded";
  stale[0]!.blocks[0]!.status = "running";
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);

  act(() => root.render(
    <SessionTimeline {...timelineProps} turns={stale} />,
  ));

  expect(host.querySelector(".animate-spin")).toBeNull();
  expect(host.querySelector("details")?.hasAttribute("open")).toBe(false);
  expect(host.querySelector("[data-streaming-caret]")).toBeNull();
  act(() => root.unmount());
  host.remove();
});
```

- [ ] **Step 3: Add a regression test for active reasoning**

Add:

```tsx
it("animates thought only when its Run is active", () => {
  const active = timelineTurn(
    "thought",
    [segment("live-thought", "正在推理", false)],
  );
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);

  act(() => root.render(
    <SessionTimeline
      {...timelineProps}
      activeRunId="run-1"
      turns={active}
    />,
  ));

  expect(host.querySelector(".animate-spin")).not.toBeNull();
  expect(host.querySelector("details")?.hasAttribute("open")).toBe(true);
  act(() => root.unmount());
  host.remove();
});
```

- [ ] **Step 4: Require an active Run in existing live Assistant tests**

Pass `activeRunId="run-1"` in the tests that expect a streaming caret or a new
Assistant reveal:

```tsx
<SessionTimeline
  {...timelineProps}
  activeRunId="run-1"
  turns={timelineTurn("assistant", segments)}
/>
```

Keep hydration, earlier-page loading, and Session-remount tests at
`activeRunId={null}` when they assert that motion does not replay.

- [ ] **Step 5: Run the timeline tests and verify the new expectations fail**

Run:

```bash
pnpm exec vitest run apps/web/src/components/session-timeline.test.tsx
```

Expected: TypeScript/runtime assertions fail because `SessionTimeline` does not
yet accept `activeRunId` and still trusts stale block status.

- [ ] **Step 6: Add authoritative active Run handling to `SessionTimeline`**

Extend the component props:

```ts
export function SessionTimeline(props: {
  activeRunId: string | null;
  turns: TimelineTurnView[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  loadingBlockId: string | null;
  onLoadSegments: (blockId: string, after: number) => void;
}) {
```

Only select an Assistant streaming segment from the active Turn:

```ts
for (const turn of props.turns) {
  if (turn.run_id !== props.activeRunId) continue;
  for (const block of turn.blocks) {
    if (block.kind !== "assistant") continue;
    for (const segment of block.segments) {
      if (!segment.sealed) activeAssistantSegmentId = segment.segment_id;
    }
  }
}
```

Restrict newly revealed Assistant segments in the effect:

```ts
const newlyLiveAssistantSegments = new Set(
  props.turns.flatMap((turn) =>
    turn.run_id === props.activeRunId
      ? turn.blocks.flatMap((block) =>
          block.kind === "assistant"
            ? block.segments
                .filter((segment) =>
                  !segment.sealed
                  && !seenSegmentIds.current?.has(segment.segment_id)
                )
                .map((segment) => segment.segment_id)
            : [],
        )
      : [],
  ),
);
```

Include `props.activeRunId` in the effect dependency array.

Pass an explicit live flag to each block:

```tsx
<TimelineBlock
  activeAssistantSegmentId={
    block.kind === "assistant" ? activeAssistantSegmentId : null
  }
  block={block}
  isLive={
    turn.run_id === props.activeRunId
    && block.status === "running"
  }
  key={block.block_id}
  loading={props.loadingBlockId === block.block_id}
  onLoadSegments={props.onLoadSegments}
/>
```

Extend `TimelineBlock` with `isLive: boolean`, then replace both uses of
`block.status === "running"` in the `<details>` branch:

```tsx
return <details
  open={props.isLive || undefined}
  className="max-w-[780px] border-t border-line"
>
  <summary className="flex cursor-pointer items-center gap-2 py-3 text-xs text-muted">
    {props.isLive && <LoaderCircle className="size-3.5 animate-spin" />}
    <span>{blockLabel(block.kind)}</span>
  </summary>
  <div className={cn(
    "grid gap-2 pb-4 text-xs leading-5",
    block.kind === "error" ? "text-danger" : "text-ink-soft",
  )}>
    {block.segments.map((segment) =>
      <TimelineSegment key={segment.segment_id} segment={segment} />
    )}
  </div>
  {more}
</details>;
```

- [ ] **Step 7: Pass the active Run ID from `Workbench`**

Add this prop to the `SessionTimeline` render:

```tsx
activeRunId={
  sessionView.snapshot.runtime.active_run?.run_id ?? null
}
```

Do not infer activity from `sessionRunning`, block order, unsealed segments, or
Turn status.

- [ ] **Step 8: Run the focused Web tests**

Run:

```bash
pnpm exec vitest run \
  apps/web/src/components/session-timeline.test.tsx \
  apps/web/src/components/composer.test.tsx \
  apps/web/src/components/markdown-composer/markdown-composer.test.tsx
```

Expected: all selected tests pass, including existing `/` trigger, source-block
keyboard, hydration, and reveal-motion regressions.

- [ ] **Step 9: Commit the timeline repair**

```bash
git add \
  apps/web/src/components/session-timeline.tsx \
  apps/web/src/components/session-timeline.test.tsx \
  apps/web/src/components/workbench.tsx
git commit \
  -m "fix(web): gate timeline motion by active run" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Validate and redeploy the local Web

**Files:**
- Build output only: `apps/bridge/dist`, `apps/web/dist`
- No source edits expected

- [ ] **Step 1: Run the combined regression suite**

Run:

```bash
pnpm exec vitest run \
  apps/bridge/src/session-api.test.ts \
  apps/web/src/components/session-timeline.test.tsx \
  apps/web/src/components/composer.test.tsx \
  apps/web/src/components/markdown-composer/markdown-composer.test.tsx
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 2: Run repository type and lint validation**

Run:

```bash
pnpm lint
```

Expected: exit code 0. Existing warning-only React Hook diagnostics may remain;
no new errors or warnings may be introduced by these files.

- [ ] **Step 3: Build Bridge and Web**

Run:

```bash
pnpm --filter @codebridge/bridge build
pnpm --filter @codebridge/web build
```

Expected: both builds exit 0 and Vite emits a new hashed Web entry asset.

- [ ] **Step 4: Restart only the launchd-managed Bridge**

Run:

```bash
launchctl kickstart -k "gui/$(id -u)/com.codebridge.bridge"
```

Do not restart Runner.

- [ ] **Step 5: Verify the deployed Web and dynamic command endpoint**

Run from `apps/bridge` so `@codebridge/core` resolves:

```bash
node --input-type=module <<'NODE'
import { ConfigStore } from "@codebridge/core";

const base = "http://127.0.0.1:19790";
const config = new ConfigStore({
  dataDir: `${process.env.HOME}/.codebridge`,
}).get();
const headers = {
  authorization: `Bearer ${config.runner.token}`,
};

const web = await fetch(`${base}/workbench/`);
if (!web.ok) throw new Error(`Web failed: ${web.status}`);

const sessionsResponse = await fetch(
  `${base}/v1/sessions?include_archived=true`,
  { headers },
);
if (!sessionsResponse.ok) {
  throw new Error(`Sessions failed: ${sessionsResponse.status}`);
}
const sessions = (await sessionsResponse.json()).sessions;
const session = sessions.find((value) => value.provider_session_id);
if (!session) throw new Error("No Provider Session found");

const commandsResponse = await fetch(
  `${base}/v1/sessions/${encodeURIComponent(session.session_id)}/commands`,
  { headers },
);
if (!commandsResponse.ok) {
  throw new Error(`Commands failed: ${commandsResponse.status}`);
}
const result = await commandsResponse.json();
if (!Array.isArray(result.commands) || result.commands.length === 0) {
  throw new Error(`No commands returned: ${JSON.stringify(result)}`);
}
console.log(JSON.stringify({
  webStatus: web.status,
  agent: session.agent_id,
  commandCount: result.commands.length,
  sample: result.commands.slice(0, 5).map((command) => command.name),
}, null, 2));
NODE
```

Expected: Web status is 200 and at least one native command is returned for the
selected Provider Session.

- [ ] **Step 6: Verify the reported UI behavior**

Open `http://127.0.0.1:19790/workbench/` and:

1. Select the same Agent and Workspace from the report.
2. Type `/` in an empty Web Composer.
3. Confirm the Agent-native command picker opens and filters after additional
   characters.
4. Open the completed Session shown in the report.
5. Confirm its historical reasoning block is collapsed and has no Spinner.
6. Start a read-only Agent message and confirm only the current Run's reasoning
   block spins.

Expected: both reported regressions are resolved without changes to Feishu or
Telegram slash behavior.
