import { expect, test } from "@playwright/test";

// Mock surface mirrors projectSessionEvent's timeline projection (A: hydrate is
// the authority). A successful runbook POST updates the mutable timeline so the
// next openSession / refresh returns the projected flow blocks.

const publishedFlow = {
  flow_id: "flow_demo_echo",
  name: "Demo Echo",
  kind: "runbook",
  status: "published",
  source: "user_selected",
  definition_revision: "sha256:def",
  plan_ir_hash: "sha256:abcdef0123456789",
  review_status: "approved",
  validation_issues: [],
  inputs: [{ id: "text", type: "string", source: "user", required: true }],
  steps: [
    { id: "echo", capability: "demo.echo", purpose: null, depends_on: [], mode: "read_only", approval: "none", branches: [], retry: null, success_when: "output.text exists" },
    { id: "concat", capability: "demo.concat", purpose: null, depends_on: ["echo"], mode: "read_only", approval: "none", branches: [], retry: null, success_when: "output.result exists" },
  ],
};

const candidateFlow = {
  ...publishedFlow,
  flow_id: "flow_demo_echo_cand",
  name: "Demo Echo Candidate",
  status: "candidate",
};

const sessionBase = {
  session_id: "sess_1",
  agent_id: "codex",
  provider_session_id: null,
  task_record_id: null,
  flow_id: null,
  model: null,
  effort: null,
  config_overrides: undefined,
  permission_mode: null,
  cwd: "/workspace",
  additional_directories: [],
  title: "Session 1",
  status: "idle",
  pinned_at: null,
  archived_at: null,
  created_at: "2026-08-20T00:00:00.000Z",
  updated_at: "2026-08-20T00:00:00.000Z",
};

function snapshotWithTimeline(timelineTurns: unknown[]) {
  return {
    session: { ...sessionBase },
    runtime: {
      active_run: null,
      queue_state: "ready",
      queue_pause_reason: null,
      queue: { turns: [], total: 0, next_cursor: null },
      version: 1,
      last_event_sequence: timelineTurns.length ? 20 : 0,
    },
    timeline: { turns: timelineTurns, previous_cursor: null, truncated_block_ids: [] },
    commands: [],
    events: [],
    options: [],
    runs: [],
  };
}

function projectedTimeline(message: string) {
  return [{
    timeline_index: 1,
    turn_id: "run_1",
    run_id: "run_1",
    status: "completed",
    blocks: [
      {
        block_id: "user:run_1", block_index: 0, kind: "user_message", status: "completed", metadata: {},
        segments: [{ segment_id: "user:run_1:0", segment_index: 0, content: message, byte_length: message.length, sealed: true }],
        next_segment_cursor: null,
      },
      { block_id: "flow_step:run_1:echo", block_index: 1, kind: "flow_step", status: "passed", metadata: { step_id: "echo", capability_id: "demo.echo" }, segments: [], next_segment_cursor: null },
      { block_id: "flow_step:run_1:concat", block_index: 2, kind: "flow_step", status: "passed", metadata: { step_id: "concat", capability_id: "demo.concat" }, segments: [], next_segment_cursor: null },
      {
        block_id: "flow_run:run_1:snapshot", block_index: 3, kind: "flow_run", status: "succeeded",
        metadata: {
          flow_id: "flow_demo_echo",
          flow_revision: "sha256:abcdef0123456789",
          outcome: "succeeded",
          resolved_inputs: [{ field: "text", value: "hi", source: "user", resolver_version: "v1" }],
          steps: [
            { step_id: "echo", capability_id: "demo.echo", capability_revision: "1", output_ref: "artifact://a1", verification_status: "passed" },
            { step_id: "concat", capability_id: "demo.concat", capability_revision: "1", output_ref: "artifact://a2", verification_status: "passed" },
          ],
        },
        segments: [], next_segment_cursor: null,
      },
    ],
  }];
}

test("published runbook main path and candidate dry-run", async ({ page }) => {
  let timelineTurns: unknown[] = [];
  let lastBody: Record<string, unknown> = {};

  await page.addInitScript(() => {
    (globalThis as typeof globalThis & { process?: { env: Record<string, string> } }).process = { env: {} };
    localStorage.setItem("codebridge:last-session:codex", "sess_1");
  });
  page.on("response", (response) => {
    const url = response.url();
    if (/v1\/(agents|sessions|flows)/.test(url)) {
      console.log(`[NET] ${response.status()} ${url}`);
    }
  });

  await page.route("**/workbench/config.json", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ token: "test" }),
  }));
  await page.route("**/v1/agents", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      agents: [{
        agent_id: "codex", display_name: "Codex", adapter: "sdk", status: "healthy",
        capabilities: ["session"], models: [], session_features: ["resume"],
        setup: {
          installation: "installed", configuration: "configured", runtime: "healthy",
          version: "test", can_select_default: true, can_create_session: true,
        },
      }],
      default_agent_id: "codex",
      effective_default_agent_id: "codex",
    }),
  }));
  await page.route("**/v1/sessions/import", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [], provider_errors: [] }),
  }));
  await page.route("**/v1/sessions?*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      sessions: [{ ...sessionBase, title: "Session 1" }],
      archived_sessions: [],
    }),
  }));
  await page.route("**/v1/sessions", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ...sessionBase, title: "Session 1" }),
  }));
  await page.route(/\/v1\/flows(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ flows: [publishedFlow, candidateFlow] }),
  }));
  await page.route("**/v1/capabilities", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ capabilities: [] }),
  }));
  await page.route("**/v1/flows/flow_demo_echo/review-context", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({
      flow: publishedFlow, base: null, provenance: null, evidence: [], history: [],
      diff: { name_changed: false, description_changed: false, inputs: { added: [], removed: [], changed: [] }, steps: { added: [], removed: [], changed: [], reordered: false } },
    }),
  }));
  await page.route("**/v1/flows/flow_demo_echo_cand/review-context", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({
      flow: candidateFlow, base: publishedFlow, provenance: null, evidence: [], history: [],
      diff: { name_changed: false, description_changed: false, inputs: { added: [], removed: [], changed: [] }, steps: { added: [], removed: [], changed: [], reordered: false } },
    }),
  }));
  await page.route("**/v1/flows/flow_demo_echo_cand", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(candidateFlow),
  }));
  await page.route("**/v1/flows/flow_demo_echo", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(publishedFlow),
  }));
  await page.route("**/v1/sessions/sess_1/options", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }));
  await page.route("**/v1/sessions/sess_1/commands", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }));
  await page.route("**/v1/sessions/sess_1/events*", (route) => route.fulfill({
    status: 200, contentType: "text/event-stream", body: ": keep-alive\n\n",
  }));
  await page.route("**/v1/sessions/sess_1/messages", async (route) => {
    const request = route.request();
    lastBody = JSON.parse(String(request.postData())) as Record<string, unknown>;
    const inputs = lastBody.inputs as Record<string, unknown> | undefined;
    const text = typeof inputs?.text === "string" ? inputs.text : "";
    if (!text) {
      return route.fulfill({
        status: 409, contentType: "application/json",
        body: JSON.stringify({ error: "missing_inputs", missing: [{ id: "text", type: "string", source: "user", reason: "required" }] }),
      });
    }
    timelineTurns = projectedTimeline(String(lastBody.message ?? ""));
    return route.fulfill({
      status: 202, contentType: "application/json",
      body: JSON.stringify({
        event_id: "e1", sequence: 20, acceptance: "dispatched",
        turn: { turn_id: "turn_1", queue_position: 0, status: "dispatched", version: 1, message: { text: String(lastBody.message), attachment_ids: [] }, created_at: "2026-08-20T00:00:00.000Z" },
        runtime: { active_run: null, queue_state: "ready", queue_pause_reason: null, queue: { turns: [], total: 0, next_cursor: null }, version: 2, last_event_sequence: 20 },
      }),
    });
  });
  await page.route("**/v1/sessions/sess_1", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(snapshotWithTimeline(timelineTurns)),
  }));

  await page.goto("/workbench/");

  // Published flow: open detail, empty text → missing highlight, keep filled value.
  await page.getByRole("button", { name: "Flows" }).click();
  await page.getByRole("button", { name: /Demo Echo runbook/ }).first().click();
  await expect(page.getByLabel("text")).toBeVisible();
  await expect(page.getByLabel("text")).toHaveValue("");
  await page.getByRole("button", { name: "运行" }).click();
  await expect(page.getByText("缺少必填参数")).toBeVisible();
  await page.getByLabel("text").fill("hi");
  await expect(page.getByText("缺少必填参数")).not.toBeVisible();
  await expect(page.getByLabel("text")).toHaveValue("hi");

  // Run → projected timeline (hydrate is authority): steps + snapshot card.
  await page.getByRole("button", { name: "运行" }).click();
  await expect(page.getByText("Run 快照")).toBeVisible();
  await expect(page.getByText("2 / 2", { exact: false })).toBeVisible();
  await expect(page.getByText("artifact://a1").first()).toBeVisible();
  await expect(page.getByText("demo.echo").first()).toBeVisible();
  expect(lastBody).toMatchObject({ flow_id: "flow_demo_echo", inputs: { text: "hi" } });
  expect(lastBody.dry_run).toBeFalsy();

  // Candidate: dry-run only, no session binding.
  await page.getByRole("button", { name: "Flows" }).click();
  await page.getByText("候选").click();
  await page.getByRole("button", { name: /Demo Echo Candidate/ }).click();
  await expect(page.getByRole("button", { name: "运行" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /预演/ })).toBeVisible();
  await page.getByRole("button", { name: /预演/ }).click();
  await expect.poll(() => lastBody).toMatchObject({ flow_id: "flow_demo_echo_cand", dry_run: true });
});
